/**
 * Fastify routes: Upload (S3 multipart) — обновлено:
 *  - В /complete добавлена идемпотентность на основе заголовка Idempotency-Key и Redis.
 *  - Публикуем только q:antivirus.media и q:metadata.media.
 *    (q:variants.image и q:transcode.video теперь публикует AV-воркер после clean)
 *
 *  POST   /v1/upload/initiate
 *  POST   /v1/upload/:mediaId/parts
 *  POST   /v1/upload/:mediaId/complete   ← идемпотентность
 *  DELETE /v1/upload/:mediaId
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',
  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',
  UPLOAD_PRESIGN_TTL_SEC = '900',
} = process.env;

function requireUser(req: any) {
  const uid = req.user?.id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(String(uid))) {
    const e: any = new Error('unauthorized'); e.statusCode = 401; throw e;
  }
  return String(uid);
}

// Простая служба upload без внешних зависимостей (минимум кода)
class UploadService {
  private partSize = 5 * 1024 * 1024;
  constructor(
    private pool: Pool,
    private redis: Redis,
    private s3: S3Client,
    private cfg = { bucket: S3_BUCKET_PRIVATE, presignTtlSec: Number(UPLOAD_PRESIGN_TTL_SEC) }
  ) {}
  async initiateMultipart(input: { ownerId: string; filename: string; mime: string; sizeBytes: number }) {
    const mediaId = randomUUID();
    const key = `original/${mediaId}`;
    // create MPU посредством SDK Presign — опускаем в этом файле; используйте свой модуль, если уже есть
    await this.pool.query(
      `INSERT INTO media_files (id, owner_id, storage_key, mime, size_bytes, antivirus_status, quarantined)
       VALUES ($1,$2,$3,$4,$5,'pending',true)`,
      [mediaId, input.ownerId, key, input.mime || 'application/octet-stream', Number(input.sizeBytes || 0)]
    );
    // Клиент у вас уже реализует пресайны; здесь возвращаем базовые параметры
    const init = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: input.mime || 'application/octet-stream',
      ACL: 'private',
    }));
    const uploadId = String(init.UploadId || '');
    if (!uploadId) { const e: any = new Error('upload_init_failed'); e.statusCode = 500; throw e; }
    return { mediaId, key, uploadId, partSize: this.partSize };
  }
  async presignPart(params: { key: string; uploadId: string; partNumber: number; contentLength?: number }) {
    const cmd = new UploadPartCommand({
      Bucket: this.cfg.bucket,
      Key: params.key,
      UploadId: params.uploadId,
      PartNumber: params.partNumber,
      ContentLength: params.contentLength,
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: this.cfg.presignTtlSec });
    return { partNumber: params.partNumber, url };
  }
}

async function publish(redis: Redis, stream: string, payload: any) {
  await redis.xadd(stream, '*', 'data', JSON.stringify(payload));
}

// Redis-бэкенд идемпотентности
async function handleIdempotencyStart(redis: Redis, key: string, ttlSec = 24 * 60 * 60) {
  // SETNX lock:<key> → '1' на 15 мин, чтобы не было двух параллельных
  const locked = await redis.set(`idem:lock:${key}`, '1', 'EX', 15 * 60, 'NX');
  if (locked !== 'OK') {
    // попробуем вернуть готовый результат, если есть
    const res = await redis.get(`idem:result:${key}`);
    if (res) return { state: 'finished' as const, result: JSON.parse(res) };
    const e: any = new Error('conflict: duplicate in-progress'); e.statusCode = 409; throw e;
  }
  // держим slot и ждём результат
  await redis.expire(`idem:result:${key}`, ttlSec);
  return { state: 'locked' as const };
}
async function handleIdempotencyFinish(redis: Redis, key: string, result: any, ttlSec = 24 * 60 * 60) {
  await redis.set(`idem:result:${key}`, JSON.stringify(result), 'EX', ttlSec);
  await redis.del(`idem:lock:${key}`);
}

export const uploadRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 7000,
    idle_in_transaction_session_timeout: 7000,
    max: 20,
  });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    maxAttempts: 3,
  });

  const svc = new UploadService(pool, redis, s3, { bucket: S3_BUCKET_PRIVATE, presignTtlSec: Number(UPLOAD_PRESIGN_TTL_SEC) });

  app.addHook('onClose', async () => {
    try { await pool.end(); } catch {}
    try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  });

  // INITIATE (оставляем как есть)
  app.post('/v1/upload/initiate', {
    schema: {
      body: {
        type: 'object',
        required: ['filename', 'mime', 'sizeBytes'],
        properties: {
          filename: { type: 'string' },
          mime: { type: 'string' },
          sizeBytes: { type: 'integer', minimum: 0 },
        },
      },
    },
    handler: async (req, reply) => {
      const ownerId = requireUser(req);
      const { filename, mime, sizeBytes } = req.body as any;
      const out = await svc.initiateMultipart({ ownerId, filename, mime, sizeBytes });
      return reply.send(out);
    },
  });

  // Presign upload part URLs
  app.post('/v1/upload/:mediaId/parts', {
    schema: {
      params: { type: 'object', required: ['mediaId'], properties: { mediaId: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['key', 'uploadId', 'parts'],
        properties: {
          key: { type: 'string' },
          uploadId: { type: 'string' },
          parts: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
    handler: async (req, reply) => {
      const ownerId = requireUser(req);
      const { mediaId } = req.params as any;
      const { key, uploadId, parts } = req.body as any;
      const check = await pool.query(`SELECT 1 FROM media_files WHERE id=$1 AND owner_id=$2 LIMIT 1`, [String(mediaId), ownerId]);
      if (!check.rowCount) { const e: any = new Error('forbidden'); e.statusCode = 403; throw e; }
      const nums = (Array.isArray(parts) ? parts : [])
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isInteger(n) && n > 0);
      const out = await Promise.all(nums.map((n: number) => svc.presignPart({ key, uploadId, partNumber: n })));
      return reply.send({ parts: out });
    },
  });

  // SIGN PART URLS — опущено ради краткости; у вас уже реализовано в модуле

  // COMPLETE — идемпотентность + публикация только AV/metadata
  app.post('/v1/upload/:mediaId/complete', {
    schema: {
      params: { type: 'object', required: ['mediaId'], properties: { mediaId: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['key', 'uploadId', 'parts'],
        properties: {
          key: { type: 'string' },
          uploadId: { type: 'string' },
          parts: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['partNumber', 'etag'],
              properties: {
                partNumber: { type: 'integer', minimum: 1 },
                etag: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: async (req, reply) => {
      // ИДЕМПОТЕНТНОСТЬ
      const ownerId = requireUser(req);
      const idemKeyHeader = String((req.headers['idempotency-key'] || '')).trim();
      if (!idemKeyHeader) return; // опционально — можно сделать обязательным
      const key = `u:${ownerId}:complete:${(req.params as any).mediaId}:${idemKeyHeader}`;
      const state = await handleIdempotencyStart(redis, key);
      if (state.state === 'finished') {
        return reply.send(state.result);
      }
      (req as any)._idemKey = key;
    },
    handler: async (req, reply) => {
      const ownerId = requireUser(req);
      const { mediaId } = req.params as any;
      const { key, uploadId, parts } = req.body as any;

      // право владельца
      const check = await pool.query(`SELECT 1 FROM media_files WHERE id=$1 AND owner_id=$2 LIMIT 1`, [String(mediaId), ownerId]);
      if (!check.rowCount) { const e: any = new Error('forbidden'); e.statusCode = 403; throw e; }

      // Завершение MPU должно быть сделано на уровне вашего S3 сервиса/модуля — опускаем ради краткости.
      // Предполагаем, что объект уже собран, делаем HEAD, фиксируем размер:
      // (В реальном коде используйте CompleteMultipartUploadCommand)
      // Здесь — просто обновим updated_at.
      // Complete multipart on S3 and mark updated
      const completed = await s3.send(new CompleteMultipartUploadCommand({
        Bucket: S3_BUCKET_PRIVATE,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: (parts as any[])
            .map((p) => ({ PartNumber: Number(p.partNumber), ETag: String(p.etag) }))
            .sort((a, b) => a.PartNumber - b.PartNumber),
        },
      }));
      if (!completed || !completed.ETag) { const e: any = new Error('upload_complete_failed'); e.statusCode = 500; throw e; }
      await pool.query(`UPDATE media_files SET updated_at=now_utc() WHERE id=$1`, [String(mediaId)]);

      // Публикуем ТОЛЬКО antivirus + metadata
      const row = await pool.query(`SELECT mime, storage_key FROM media_files WHERE id=$1 LIMIT 1`, [String(mediaId)]);
      const mime = String(row.rows[0]?.mime || 'application/octet-stream');
      const storageKey = String(row.rows[0]?.storage_key || key);

      await publish(redis, 'q:antivirus.media', { mediaId: String(mediaId), storageKey, mime });
      await publish(redis, 'q:metadata.media',  { mediaId: String(mediaId), storageKey, mime });

      const result = { ok: true as const, bytes: null, mediaId: String(mediaId) };

      // Завершим идемпотентность (если была)
      const idemKey = (req as any)._idemKey as string | undefined;
      if (idemKey) {
        await handleIdempotencyFinish(redis, idemKey, result);
      }

      return reply.send(result);
    },
  });

  // ABORT — без изменений
  app.delete('/v1/upload/:mediaId', {
    schema: {
      params: { type: 'object', required: ['mediaId'], properties: { mediaId: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['key', 'uploadId'],
        properties: {
          key: { type: 'string' },
          uploadId: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const ownerId = requireUser(req);
      const { mediaId } = req.params as any;
      const { key, uploadId } = req.body as any;
      const check = await pool.query(`SELECT 1 FROM media_files WHERE id=$1 AND owner_id=$2 LIMIT 1`, [String(mediaId), ownerId]);
      if (!check.rowCount) { const e: any = new Error('forbidden'); e.statusCode = 403; throw e; }
      try { await s3.send(new AbortMultipartUploadCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key, UploadId: uploadId })); } catch {}
      await pool.query(`DELETE FROM media_files WHERE id=$1`, [String(mediaId)]).catch(() => {});
      return reply.send({ ok: true as const });
    },
  });
};

export default uploadRoutes;
