// apps/api/src/middleware/idempotency.ts
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import crypto from 'node:crypto';
import { redis } from '@redis/index';

type IdemState = {
  engaged: boolean;         // идемпотентность активна для этого запроса
  skipStore?: boolean;      // не сохранять (например, когда отдали ответ из кеша)
  key: string;              // значение заголовка Idempotency-Key
  scope: string;            // область (method + path + user)
  resKey: string;           // ключ в Redis для сохранённого ответа
  lockKey: string;          // ключ блокировки "в работе"
  ttlSec: number;           // TTL сохраненного ответа
  lockTtlSec: number;       // TTL блокировки
  maxStoreBytes: number;    // лимит на размер сохраняемого тела
};

/** Настройки плагина */
export type IdempotencyOptions = {
  ttlSec?: number;          // TTL сохраненного ответа (по умолчанию 24 часа)
  lockTtlSec?: number;      // TTL блокировки (по умолчанию 120 сек)
  maxStoreBytes?: number;   // лимит размера сохраняемого тела (по умолчанию 256 КБ)
};

/** Методы, для которых имеет смысл идемпотентность */
const TARGET_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Валидация ключа из заголовка */
function validateKey(key: string): boolean {
  if (!key) return false;
  if (key.length < 16 || key.length > 200) return false;
  // Разрешим URL-safe base64 / hex / UUID-подобные
  return /^[A-Za-z0-9_\-:.]+$/.test(key);
}

/** Безопасный хеш пути */
function hashPath(path: string): string {
  return crypto.createHash('sha1').update(path).digest('hex').slice(0, 16);
}

/** Получить userId из req.user, если guard его установил */
function getUserId(req: FastifyRequest): string {
  // @ts-expect-error - user выставляется auth.guard'ом
  const uid = req.user?.id as string | undefined;
  return uid || 'anon';
}

/** Построить scope для ключей Redis: метод|pathHash|uid */
function buildScope(req: FastifyRequest): string {
  const method = (req.method || 'POST').toUpperCase();
  const path = (req.routerPath || req.url.split('?')[0] || '/').toString();
  const uid = getUserId(req);
  return `${method}|${hashPath(path)}|${uid}`;
}

/** Утилита ответа об ошибке идемпотентности */
function idemError(reply: FastifyReply, status: number, code: string, message: string, extra?: any) {
  if (status === 409) reply.header('Retry-After', '5');
  return reply.code(status).send({ error: { code, message, details: extra } });
}

/** Список заголовков, которые есть смысл сохранять/воспроизводить */
const ALLOWED_RES_HEADERS = new Set([
  'content-type', 'content-length', 'etag', 'last-modified', 'location', 'cache-control'
]);

/** Извлечь body как Buffer (если строка/Buffer/объект) и оригинальный объект для JSON */
function normalizePayload(payload: any): { buf: Buffer; json?: any; isJson: boolean } {
  if (payload === null || payload === undefined) return { buf: Buffer.alloc(0), isJson: false };
  if (Buffer.isBuffer(payload)) return { buf: payload, isJson: false };
  if (typeof payload === 'string') return { buf: Buffer.from(payload), isJson: false };
  // объект — сериализуем в JSON
  const jsonStr = JSON.stringify(payload);
  return { buf: Buffer.from(jsonStr), json: payload, isJson: true };
}

/** Воспроизвести сохранённый ответ */
async function replayStoredResponse(reply: FastifyReply, record: StoredResponse) {
  // заголовки
  for (const [k, v] of Object.entries(record.headers || {})) {
    reply.header(k, v as any);
  }
  // статус
  reply.code(record.status || 200);
  // тело
  if (record.isJson) {
    reply.send(record.bodyJson ?? null);
  } else {
    const data = record.bodyBase64 ? Buffer.from(record.bodyBase64, 'base64') : Buffer.alloc(0);
    reply.send(data);
  }
}

type StoredResponse = {
  status: number;
  headers: Record<string, string>;
  isJson: boolean;
  bodyBase64?: string; // хранение бинарного/строчного
  bodyJson?: any;      // хранение JSON как объект (для экономии)
};

/**
 * Зарегистрировать глобальные хуки идемпотентности.
 * Логика:
 *  - preHandler: если есть целевой метод и корректный Idempotency-Key:
 *    - ищем сохранённый ответ → отдаём сразу
 *    - иначе пытаемся поставить блокировку (SET NX) → если неудачно, 409 In-Progress
 *  - onSend: если engaged и не skipStore → сохраняем результат (< 500) и снимаем блокировку
 */
export async function registerIdempotency(app: FastifyInstance, opts: IdempotencyOptions = {}) {
  const ttlSec = Math.max(60, Math.min(opts.ttlSec ?? 24 * 3600, 7 * 24 * 3600)); // 1д ≤ TTL ≤ 7д
  const lockTtlSec = Math.max(5, Math.min(opts.lockTtlSec ?? 120, 3600));        // 5с ≤ lock ≤ 1ч
  const maxStoreBytes = Math.max(1024, Math.min(opts.maxStoreBytes ?? 256 * 1024, 5 * 1024 * 1024)); // 1Кб..5Мб

  app.addHook('preHandler', async (req, reply) => {
    // активируем только на целевых методах
    if (!TARGET_METHODS.has((req.method || '').toUpperCase())) return;

    const key = (req.headers['idempotency-key'] || '').toString();
    if (!key) return; // ключ не обязателен глобально — можно потребовать на уровне роутов requireIdempotency()
    if (!validateKey(key)) {
      return idemError(reply, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 16..200 URL-safe chars');
    }

    const scope = buildScope(req);
    const resKey = `idem:res:${scope}:${key}`;
    const lockKey = `idem:lock:${scope}:${key}`;

    // 1) Если есть готовый результат — сразу отдадим
    const cached = await redis.get(resKey);
    if (cached) {
      const record: StoredResponse = JSON.parse(cached);
      // помечаем, что мы ответили из кеша — onSend не должен ничего сохранять
      (req as any).__idem = { engaged: true, key, scope, resKey, lockKey, ttlSec, lockTtlSec, maxStoreBytes, skipStore: true } as IdemState;
      return await replayStoredResponse(reply, record);
    }

    // 2) Ставим блокировку. Если не удалось — другой запрос «в работе».
    const ok = await redis.set(lockKey, '1', { NX: true, EX: lockTtlSec });
    if (!ok) {
      return idemError(reply, 409, 'IDEMPOTENCY_IN_PROGRESS', 'Another request with the same Idempotency-Key is being processed', { retryAfterSec: 5 });
    }

    // помечаем состояние — чтобы onSend знал, что надо сохранить
    (req as any).__idem = { engaged: true, key, scope, resKey, lockKey, ttlSec, lockTtlSec, maxStoreBytes } as IdemState;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const state: IdemState | undefined = (req as any).__idem;
    if (!state || !state.engaged || state.skipStore) return payload;

    try {
      // если произошла серверная ошибка — не кэшируем, снятие блокировки позволит ретрай
      const status = reply.statusCode || 200;
      if (status >= 500) {
        await redis.del(state.lockKey);
        return payload;
      }

      // собираем допустимые заголовки
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(reply.getHeaders())) {
        const lk = k.toLowerCase();
        if (!ALLOWED_RES_HEADERS.has(lk)) continue;
        // reply.getHeaders() может отдавать string|number|string[]
        headers[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }

      // нормализуем тело
      const norm = normalizePayload(payload);
      if (norm.buf.length > state.maxStoreBytes) {
        // слишком большой ответ — не сохраняем, но снимаем блокировку
        await redis.del(state.lockKey);
        return payload;
      }

      const record: StoredResponse = {
        status,
        headers,
        isJson: norm.isJson,
        bodyBase64: norm.isJson ? undefined : norm.buf.toString('base64'),
        bodyJson: norm.isJson ? norm.json ?? null : undefined
      };

      // сохраним и снимем блокировку атомарно: MULTI
      const pipe = redis.multi();
      pipe.set(state.resKey, JSON.stringify(record), { EX: state.ttlSec });
      pipe.del(state.lockKey);
      await pipe.exec();

      return payload;
    } catch {
      // в любом непредвиденном случае — не мешаем ответу, блокировку снимаем для здоровья
      try { await redis.del(state.lockKey); } catch {}
      return payload;
    }
  });

  app.log.info({
    msg: 'idempotency middleware registered',
    ttlSec, lockTtlSec, maxStoreBytes
  });
}

/**
 * Хелпер для маршрутов, где наличие Idempotency-Key ОБЯЗАТЕЛЬНО.
 * Если заголовка нет или он некорректен — вернёт 400.
 * Работает совместно с глобальным registerIdempotency: preHandler проверит ключ, а onSend сохранит ответ.
 */
export function requireIdempotency(): preHandlerHookHandler {
  return async (req, reply) => {
    if (!TARGET_METHODS.has((req.method || '').toUpperCase())) return;
    const key = (req.headers['idempotency-key'] || '').toString();
    if (!validateKey(key)) {
      return idemError(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Valid Idempotency-Key header is required');
    }
  };
}
