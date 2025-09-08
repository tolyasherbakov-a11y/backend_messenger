// modules/media/index.ts
import { z } from 'zod';
import { sql, transaction } from '@db/index';
import { presignGetObject } from '@s3/index';

/* ============================================================================
 * Типы и схемы
 * ========================================================================== */

export type MediaMeta = {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdBy: string;
  createdAt: string; // ISO
  variants: Array<{
    profile: string;        // 'thumb@256', 'compressed', '360p', '480p', '720p', '1080p', ...
    storageKey: string;
    width: number | null;
    height: number | null;
    bitrate: number | null;
  }>;
};

export type MediaWithLinks = MediaMeta & {
  links: {
    original?: string;
    variants?: Record<string, string>; // profile -> presigned URL
  };
};

const IdSchema = z.string().min(1);
const OwnerSchema = z.string().min(1);

const ListQuery = z.object({
  userId: OwnerSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional() // base64url({"created_at": "...", "id": "..."})
});
export type ListQuery = z.infer<typeof ListQuery>;

type CursorT = { created_at: string; id: string };
function encCursor(c: CursorT): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decCursor(cur?: string | null): CursorT | null {
  if (!cur) return null;
  try {
    const o = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
    return (o && typeof o.created_at === 'string' && typeof o.id === 'string') ? o : null;
  } catch { return null; }
}

/* ============================================================================
 * Маппинг строк БД → DTO
 * ========================================================================== */

function mapMetaRow(r: any, variants: any[]): MediaMeta {
  return {
    id: r.id,
    sha256: r.sha256,
    mime: r.mime,
    size: Number(r.size),
    width: r.width ?? null,
    height: r.height ?? null,
    duration: r.duration !== null && r.duration !== undefined ? Number(r.duration) : null,
    createdBy: r.created_by,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    variants: variants.map(v => ({
      profile: v.profile,
      storageKey: v.storage_key,
      width: v.width ?? null,
      height: v.height ?? null,
      bitrate: v.bitrate !== null && v.bitrate !== undefined ? Number(v.bitrate) : null
    }))
  };
}

/* ============================================================================
 * ACL
 * ========================================================================== */

/**
 * Простая и строгая ACL: доступ только владельцу (created_by).
 * До подключения моделей каналов/групп это безопасное дефолт-поведение.
 */
function checkAccessOrThrow(requesterId: string | undefined, ownerId: string) {
  if (!requesterId || requesterId !== ownerId) {
    const e: any = new Error('Forbidden');
    e.code = 'FORBIDDEN';
    throw e;
  }
}

/* ============================================================================
 * Публичные операции
 * ========================================================================== */

/**
 * Получить метаданные медиа + пресайн-ссылки (оригинал и все варианты).
 * ACL: владелец-только.
 */
export async function getMetaWithLinks(args: { mediaId: string; requesterId: string }): Promise<MediaWithLinks> {
  const mediaId = IdSchema.parse(args.mediaId);
  const requesterId = OwnerSchema.parse(args.requesterId);

  // Грузим сам объект
  const rows = await sql`
    SELECT id, sha256, mime, size, width, height, duration, storage_key, created_by, created_at
    FROM media_files
    WHERE id = ${mediaId}
    LIMIT 1
  `;
  if (!rows.length) {
    const e: any = new Error('Media not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const m = rows[0];

  // ACL
  checkAccessOrThrow(requesterId, m.created_by);

  // Грузим варианты
  const vars = await sql`
    SELECT profile, storage_key, width, height, bitrate
    FROM media_variants
    WHERE media_id = ${mediaId}
    ORDER BY profile
  `;

  // Собираем DTO
  const meta = mapMetaRow(m, vars);

  // Пресайн-ссылки
  const links: MediaWithLinks['links'] = { variants: {} };
  if (m.storage_key) {
    links.original = await presignGetObject(m.storage_key);
  }
  for (const v of meta.variants) {
    links.variants![v.profile] = await presignGetObject(v.storageKey);
  }

  return { ...meta, links };
}

/**
 * Список медиа текущего пользователя (cursor-based).
 * Возвращает без пресайнов (их можно запрашивать поштучно через getMetaWithLinks).
 */
export async function listMyMedia(params: ListQuery): Promise<{ items: MediaMeta[]; nextCursor: string | null }> {
  const { userId, limit } = ListQuery.parse(params);
  const cur = decCursor(params.cursor ?? null);

  const rows = await (async () => {
    if (!cur) {
      return await sql`
        SELECT id, sha256, mime, size, width, height, duration, storage_key, created_by, created_at
        FROM media_files
        WHERE created_by = ${userId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `;
    }
    return await sql`
      SELECT id, sha256, mime, size, width, height, duration, storage_key, created_by, created_at
      FROM media_files
      WHERE created_by = ${userId}
        AND (created_at, id) < (${cur.created_at}::timestamptz, ${cur.id})
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  })();

  // Соберём id → variants[]
  const ids = rows.slice(0, Math.min(rows.length, limit)).map(r => r.id);
  const varMap: Record<string, any[]> = {};
  if (ids.length) {
    const vars = await sql`
      SELECT media_id, profile, storage_key, width, height, bitrate
      FROM media_variants
      WHERE media_id = ANY(${ids})
      ORDER BY profile
    `;
    for (const v of vars as any[]) {
      (varMap[v.media_id] ||= []).push(v);
    }
  }

  let nextCursor: string | null = null;
  let slice = rows;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = encCursor({ created_at: last.created_at.toISOString(), id: last.id });
    slice = rows.slice(0, limit);
  }

  const items = slice.map(r => mapMetaRow(r, varMap[r.id] || []));
  return { items, nextCursor };
}

/**
 * Увеличить счётчик ссылок (например, при привязке медиа к посту/сообщению).
 */
export async function incrementRefCount(mediaId: string, by: number = 1): Promise<void> {
  const res = await sql`
    UPDATE media_files
    SET ref_count = ref_count + ${by}
    WHERE id = ${mediaId}
    RETURNING id
  `;
  if (!res.length) {
    const e: any = new Error('Media not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
}

/**
 * Попытаться уменьшить счётчик и, если стал 0 — инициировать сборку мусора (удаление из S3 выполняют воркеры).
 * Здесь мы только ставим задачу в очередь через таблицу событий (или Redis Streams, если используется).
 * В этой реализации — запишем событие в отдельную таблицу media_gc_events (если есть) или вернём флаг.
 * Чтобы не полагаться на доп. таблицы, оставим корректную логику ref_count и сообщим вызывающему о состоянии.
 */
export async function tryDecrement(mediaId: string): Promise<{ refCount: number }> {
  const rows = await transaction(async (trx) => {
    await trx.sql`UPDATE media_files SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = ${mediaId}`;
    const r = await trx.sql`SELECT ref_count FROM media_files WHERE id = ${mediaId}`;
    return r;
  });
  if (!rows.length) {
    const e: any = new Error('Media not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return { refCount: Number(rows[0].ref_count) };
}

/**
 * Получить только пресайн на конкретный вариант, с ACL.
 */
export async function getPresignedVariant(args: { mediaId: string; profile: string; requesterId: string }): Promise<{ url: string }> {
  const { mediaId, profile, requesterId } = z.object({
    mediaId: IdSchema,
    profile: z.string().min(1),
    requesterId: OwnerSchema
  }).parse(args);

  // Проверяем владельца
  const owner = await sql`SELECT created_by FROM media_files WHERE id = ${mediaId}`;
  if (!owner.length) {
    const e: any = new Error('Media not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  checkAccessOrThrow(requesterId, owner[0].created_by);

  // Ищем вариант
  const v = await sql`
    SELECT storage_key FROM media_variants
    WHERE media_id = ${mediaId} AND profile = ${profile}
    LIMIT 1
  `;
  if (!v.length) {
    const e: any = new Error('Variant not found');
    e.code = 'VARIANT_NOT_FOUND';
    throw e;
  }
  const url = await presignGetObject(v[0].storage_key);
  return { url };
}

/**
 * Получить пресайн на оригинал, с ACL.
 */
export async function getPresignedOriginal(args: { mediaId: string; requesterId: string }): Promise<{ url: string }> {
  const { mediaId, requesterId } = z.object({ mediaId: IdSchema, requesterId: OwnerSchema }).parse(args);

  const rows = await sql`
    SELECT storage_key, created_by
    FROM media_files
    WHERE id = ${mediaId}
    LIMIT 1
  `;
  if (!rows.length) {
    const e: any = new Error('Media not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  checkAccessOrThrow(requesterId, rows[0].created_by);

  const url = await presignGetObject(rows[0].storage_key);
  return { url };
}
