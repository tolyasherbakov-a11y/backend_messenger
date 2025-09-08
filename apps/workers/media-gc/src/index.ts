/* eslint-disable no-console */
/**
 * Media-GC worker:
 * 1) Периодически сканирует БД и удаляет:
 *    - сиротские медиа (ref_count=0, старше grace, не pending AV);
 *    - истёкшие quarantine (quarantined=true & scanned_at < TTL);
 *    - просроченные upload_sessions (expires_at < now) -> status='expired', затем очистка мусора.
 * 2) Обрабатывает явные задания из Redis Stream `q:gc.media`:
 *    - { type: 'delete_media', mediaId }
 *    - { type: 'delete_variant', mediaId, profile }
 *    - { type: 'cleanup_uploads' }
 *
 * Удаление выполняется в порядке: S3 variants -> S3 original -> DELETE FROM media_files (CASCADE variants).
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const {
  NODE_ENV = 'production',
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',

  // Redis Streams
  STREAM_NAME = 'q:gc.media',
  GROUP_NAME = 'g:gc',
  DLQ_STREAM = 'q:dlq:gc.media',

  // Политика GC
  GC_ORPHAN_GRACE_HOURS = '12',          // медиа без ссылок удаляем, если старше 12ч
  GC_QUARANTINE_TTL_HOURS = '72',        // карантин истекает через 72ч, после — удаляем
  GC_SCAN_INTERVAL_MS = '60000',         // периодичность фонового сканера (60с)
  GC_BATCH_SIZE = '200',                 // размер партии удаления
  CONCURRENCY = '1',
} = process.env;

const pool = new Pool({
  connectionString: DB_URL,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
  max: 10,
});

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableAutoPipelining: true,
});

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  maxAttempts: 3,
});

type Job =
  | { type: 'delete_media'; mediaId: string }
  | { type: 'delete_variant'; mediaId: string; profile: '360p'|'480p'|'720p'|'1080p' }
  | { type: 'cleanup_uploads' };

function randomId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM');
  } catch (e: any) {
    if (String(e?.message || e).includes('BUSYGROUP')) return;
    console.error('xgroup create error', e);
    throw e;
  }
}

/** Получить список variants для mediaId */
async function fetchVariants(mediaId: string): Promise<Array<{ storage_key: string }>> {
  const q = await pool.query(
    `SELECT storage_key FROM media_variants WHERE media_id = $1`,
    [mediaId]
  );
  return q.rows as any;
}

/** Получить ключ оригинала */
async function fetchOriginalKey(mediaId: string): Promise<string | null> {
  const q = await pool.query(
    `SELECT storage_key FROM media_files WHERE id = $1`,
    [mediaId]
  );
  return q.rowCount ? (q.rows[0].storage_key as string) : null;
}

/** Удалить список ключей в S3 батчем */
async function s3DeleteMany(keys: string[]) {
  if (keys.length === 0) return;
  // Разбиваем на партии по 1000 (лимит S3 DeleteObjects)
  const chunkSize = 1000;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    await s3.send(new DeleteObjectsCommand({
      Bucket: S3_BUCKET_PRIVATE,
      Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
    }));
  }
}

/** Удалить один ключ в S3 */
async function s3DeleteOne(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
}

/** Полное удаление media: variants -> original -> DB row */
async function deleteMedia(mediaId: string) {
  // 1) собрать ключи вариантов
  const variants = await fetchVariants(mediaId);
  const variantKeys = variants.map(v => v.storage_key);

  // 2) ключ оригинала
  const orig = await fetchOriginalKey(mediaId);

  // 3) удалить из S3 (варианты пачкой, потом оригинал)
  await s3DeleteMany(variantKeys);
  if (orig) { await s3DeleteOne(orig); }

  // 4) удалить строку media_files (CASCADE variants)
  await pool.query(`DELETE FROM media_files WHERE id = $1`, [mediaId]);
}

/** Удалить конкретный вариант (не трогая оригинал) */
async function deleteVariant(mediaId: string, profile: '360p'|'480p'|'720p'|'1080p') {
  const q = await pool.query(
    `DELETE FROM media_variants
      WHERE media_id = $1 AND profile = $2
      RETURNING storage_key`,
    [mediaId, profile]
  );
  if (!q.rowCount) return;
  const key = q.rows[0].storage_key as string;
  await s3DeleteOne(key);
}

/** Фоновый скан: сироты */
async function scanOrphans() {
  const grace = Math.max(0, Number(GC_ORPHAN_GRACE_HOURS) || 12);
  const limit = Math.max(1, Number(GC_BATCH_SIZE) || 200);
  // Не трогаем pending AV (пусть досканируется). Удаляем только неиспользуемые (ref_count=0) и достаточно старые.
  const q = await pool.query(
    `SELECT id FROM media_files
      WHERE ref_count = 0
        AND antivirus_status <> 'pending'
        AND created_at < now_utc() - ($1::text || ' hours')::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [String(grace), String(limit)]
  );
  for (const row of q.rows) {
    try {
      await deleteMedia(row.id as string);
      console.log(`gc orphan deleted media ${row.id}`);
    } catch (e) {
      console.error('gc orphan delete failed', row.id, e);
    }
  }
}

/** Фоновый скан: истекший карантин */
async function scanQuarantine() {
  const ttl = Math.max(1, Number(GC_QUARANTINE_TTL_HOURS) || 72);
  const limit = Math.max(1, Number(GC_BATCH_SIZE) || 200);
  const q = await pool.query(
    `SELECT id FROM media_files
      WHERE quarantined = true
        AND scanned_at IS NOT NULL
        AND scanned_at < now_utc() - ($1::text || ' hours')::interval
      ORDER BY scanned_at ASC
      LIMIT $2`,
    [String(ttl), String(limit)]
  );
  for (const row of q.rows) {
    try {
      await deleteMedia(row.id as string);
      console.log(`gc quarantine deleted media ${row.id}`);
    } catch (e) {
      console.error('gc quarantine delete failed', row.id, e);
    }
  }
}

/** Фоновый скан: upload_sessions -> просроченные */
async function scanUploadSessions() {
  const limit = Math.max(1, Number(GC_BATCH_SIZE) || 200);
  // Помечаем просроченные initiated/aborted как expired (для аудита)
  await pool.query(
    `UPDATE upload_sessions
       SET status = 'expired', updated_at = now_utc()
     WHERE expires_at < now_utc() AND status IN ('initiated','aborted')
     LIMIT $1`, // PostgreSQL до 16 не поддерживает LIMIT в UPDATE, поэтому…
    [limit]
  ).catch(async () => {
    // …fallback: делаем через PK выборку и пакетный апдейт.
    const sel = await pool.query(
      `SELECT id FROM upload_sessions
         WHERE expires_at < now_utc() AND status IN ('initiated','aborted')
         ORDER BY expires_at ASC
         LIMIT $1`,
      [limit]
    );
    if (sel.rowCount) {
      const ids = sel.rows.map(r => r.id);
      await pool.query(`UPDATE upload_sessions SET status='expired', updated_at=now_utc() WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });
}

/** Периодический фоновый скан */
async function backgroundScannerLoop() {
  const interval = Math.max(5_000, Number(GC_SCAN_INTERVAL_MS) || 60_000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await scanOrphans();
      await scanQuarantine();
      await scanUploadSessions();
    } catch (e) {
      console.error('background scan error', e);
    }
    await delay(interval);
  }
}

/** Обработчик явных заданий из Streams */
async function processJob(job: Job) {
  switch (job.type) {
    case 'delete_media':
      if (!job.mediaId) throw new Error('delete_media: mediaId required');
      await deleteMedia(job.mediaId);
      return;
    case 'delete_variant':
      if (!job.mediaId) throw new Error('delete_variant: mediaId required');
      await deleteVariant(job.mediaId, job.profile);
      return;
    case 'cleanup_uploads':
      await scanUploadSessions();
      return;
    default:
      throw new Error(`unknown job type`);
  }
}

/** Основной цикл чтения Streams */
async function streamsLoop() {
  await ensureGroup();
  const consumer = `c:${randomId()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 1);
  const inflight = new Set<Promise<void>>();

  console.log(`Media-GC worker started; stream=${STREAM_NAME} group=${GROUP_NAME}`);

  async function readOnce() {
    const res = await redis.xreadgroup('GROUP', GROUP_NAME, consumer, 'BLOCK', 5000, 'COUNT', concurrency, 'STREAMS', STREAM_NAME, '>');
    if (!res) return;
    for (const [, entries] of res as any[]) {
      for (const [id, fields] of entries as any[]) {
        const dataStr = fields?.data || fields?.[1] || '';
        let payload: any = null;
        try {
          payload = JSON.parse(String(dataStr));
        } catch {
          await redis.xack(STREAM_NAME, GROUP_NAME, id);
          await redis.xadd(DLQ_STREAM, '*', 'reason', 'bad_json', 'data', String(dataStr));
          continue;
        }

        const p = (async () => {
          try {
            await processJob(payload as Job);
            await redis.xack(STREAM_NAME, GROUP_NAME, id);
          } catch (err) {
            console.error('gc job failed', err);
            await redis.xack(STREAM_NAME, GROUP_NAME, id);
            await redis.xadd(
              DLQ_STREAM,
              '*',
              'reason', 'processing_failed',
              'error', String((err as Error).message || err),
              'data', JSON.stringify(payload)
            );
          }
        })().finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await readOnce();
    } catch (e) {
      console.error('read loop error', e);
      await delay(1000);
    }
    while (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }
  }
}

/** Инициализация и запуск двух параллельных лупов */
async function main() {
  // Пробные пинги
  await Promise.all([pool.query('SELECT 1'), redis.ping()]);
  // Параллельно запускаем фоновый скан и обработку stream-заданий
  await Promise.race([backgroundScannerLoop(), streamsLoop()]);
}

// Грациозное завершение
async function shutdown() {
  console.log('shutdown...');
  try { await pool.end(); } catch {}
  try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Старт
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
