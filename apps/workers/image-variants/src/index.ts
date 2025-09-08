/* eslint-disable no-console */
/**
 * Image Variants worker
 *
 * Очередь:
 *   - Redis Stream: q:variants.image  (группа: g:img)
 *   - Сообщение: JSON { mediaId: string, storageKey: string, mime: string }
 *
 * Поведение:
 *   1) Проверяет, что media_files существует и файл не в карантине (antivirus_status='clean' AND quarantined=false)
 *   2) Скачивает оригинал из S3 во временный каталог
 *   3) Через sharp:
 *        - auto-orient (EXIF)
 *        - генерирует профили: thumb(256w), medium(720w), large(1280w)
 *        - отдаёт два формата: WebP и AVIF
 *   4) Загружает варианты обратно в S3 по ключам:
 *        variants/<mediaId>/images/<profile>.<ext>
 *      (например: variants/UUID/images/thumb.webp, thumb.avif, medium.webp, ...)
 *   5) UPSERT в media_variants (profile, storage_key, width, height, bitrate_kbps=NULL, duration_ms=NULL)
 *   6) Ошибки — в DLQ q:dlq:variants.image; tmp-файлы чистятся
 *
 * ENV:
 *   DB_URL, REDIS_URL
 *   S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_PRIVATE
 *   STREAM_NAME (default q:variants.image), GROUP_NAME (g:img), DLQ_STREAM (q:dlq:variants.image)
 *   CONCURRENCY (default 2), TMP_DIR (optional)
 */

import { promises as fsp, createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import Redis from 'ioredis';
import sharp from 'sharp';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

type Job = { mediaId: string; storageKey: string; mime?: string };

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',

  STREAM_NAME = 'q:variants.image',
  GROUP_NAME = 'g:img',
  DLQ_STREAM = 'q:dlq:variants.image',

  CONCURRENCY = '2',
  TMP_DIR = '',
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

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
function rid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM');
  } catch (e: any) {
    if (String(e?.message || e).includes('BUSYGROUP')) return;
    throw e;
  }
}

async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function downloadFromS3(key: string, toFile: string) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
  await fsp.mkdir(dirname(toFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    (resp.Body as any)
      .pipe(createWriteStream(toFile))
      .on('finish', () => resolve())
      .on('error', reject);
  });
}

async function uploadToS3(key: string, fromFile: string, contentType: string) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET_PRIVATE,
    Key: key,
    Body: createReadStream(fromFile),
    ContentType: contentType,
  }));
}

async function upsertVariant(mediaId: string, profile: string, storageKey: string, width: number, height: number) {
  await pool.query(
    `INSERT INTO media_variants (media_id, profile, storage_key, width, height, duration_ms, bitrate_kbps)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     ON CONFLICT (media_id, profile)
     DO UPDATE SET storage_key = EXCLUDED.storage_key,
                   width = EXCLUDED.width,
                   height = EXCLUDED.height,
                   updated_at = now_utc()`,
    [mediaId, profile, storageKey, width, height]
  );
}

const PROFILES: Array<{ name: 'thumb'|'medium'|'large'; width: number }> = [
  { name: 'thumb',  width: 256 },
  { name: 'medium', width: 720 },
  { name: 'large',  width: 1280 },
];

const FORMATS: Array<{ ext: 'webp'|'avif'; contentType: string }> = [
  { ext: 'webp', contentType: 'image/webp' },
  { ext: 'avif', contentType: 'image/avif' },
];

function isImageMime(m?: string): boolean {
  if (!m) return false;
  return /^image\//i.test(m);
}

async function processJob(job: Job) {
  if (!job?.mediaId || !job?.storageKey) throw new Error('bad_job');
  // валидация записи и статуса антивируса/карантина
  const q = await pool.query(
    `SELECT id, antivirus_status, quarantined FROM media_files WHERE id=$1 LIMIT 1`,
    [job.mediaId]
  );
  if (!q.rowCount) throw new Error('media_not_found');
  const row = q.rows[0];
  if (row.quarantined || row.antivirus_status !== 'clean') {
    throw new Error(`media_not_clean_or_quarantined: ${row.antivirus_status}`);
  }

  if (!isImageMime(job.mime)) {
    throw new Error(`unsupported_mime:${job.mime || 'unknown'}`);
  }

  if (!(await s3ObjectExists(job.storageKey))) {
    throw new Error(`s3_missing:${job.storageKey}`);
  }

  // рабочая директория
  const baseTmp = TMP_DIR || tmpdir();
  const workDir = join(baseTmp, `img-${randomUUID()}`);
  const srcPath = join(workDir, 'source.bin');
  await fsp.mkdir(workDir, { recursive: true });

  try {
    // загрузим оригинал
    await downloadFromS3(job.storageKey, srcPath);

    // загрузим через sharp, применим авто-ориентацию
    const src = sharp(srcPath, { failOn: 'none' }).rotate(); // auto-orient

    const meta = await src.metadata();
    if (!meta.width || !meta.height) throw new Error('image_meta_missing');

    for (const prof of PROFILES) {
      // Не увеличиваем изображения: если исходник меньше — уменьшаем профиль до исходного.
      const targetW = Math.min(meta.width, prof.width);

      const pipeline = sharp(srcPath).rotate().resize({
        width: targetW,
        withoutEnlargement: true,
        fit: 'inside',
        fastShrinkOnLoad: true,
      });

      // Параллельно создадим webp и avif в файлы
      for (const fmt of FORMATS) {
        const outDir = join(workDir, prof.name);
        const outPath = join(outDir, `image.${fmt.ext}`);
        await fsp.mkdir(outDir, { recursive: true });

        let s = pipeline.clone();
        if (fmt.ext === 'webp') {
          s = s.webp({
            quality: 82, effort: 4,
            smartSubsample: true,
            nearLossless: false,
          });
        } else {
          s = s.avif({
            quality: 55, effort: 4,
            chromaSubsampling: '4:2:0',
          });
        }

        await s.toFile(outPath);

        // Получим фактический размер результата
        const outMeta = await sharp(outPath).metadata();
        const w = outMeta.width || targetW;
        const h = outMeta.height || Math.round(w * (meta.height! / meta.width!));

        // S3 key
        const key = `variants/${job.mediaId}/images/${prof.name}.${fmt.ext}`;
        await uploadToS3(key, outPath, fmt.contentType);

        // БД: profile кодируем как "<profile>_<ext>" — уникально на media_id
        await upsertVariant(job.mediaId, `img_${prof.name}_${fmt.ext}`, key, w, h);
      }
    }

    console.log(`image variants ready media=${job.mediaId}`);
  } finally {
    // очистка tmp
    try { await fsp.rm(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function loop() {
  await ensureGroup();
  const consumer = `c:${rid()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 2);
  const inflight = new Set<Promise<void>>();

  console.log(`Image-Variants worker started; stream=${STREAM_NAME} group=${GROUP_NAME}`);

  async function readOnce() {
    const res = await redis.xreadgroup('GROUP', GROUP_NAME, consumer, 'BLOCK', 5000, 'COUNT', concurrency, 'STREAMS', STREAM_NAME, '>');
    if (!res) return;

    for (const [, entries] of res as any[]) {
      for (const [id, fields] of entries as any[]) {
        const dataStr = fields?.data || fields?.[1] || '';
        let payload: Job | null = null;
        try {
          payload = JSON.parse(String(dataStr));
        } catch {
          await redis.xack(STREAM_NAME, GROUP_NAME, id);
          await redis.xadd(DLQ_STREAM, '*', 'reason', 'bad_json', 'data', String(dataStr));
          continue;
        }

        const p = (async () => {
          try {
            await processJob(payload!);
            await redis.xack(STREAM_NAME, GROUP_NAME, id);
          } catch (err) {
            console.error('image-variants failed', err);
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
    try { await readOnce(); }
    catch (e) { console.error('read loop error', e); await sleep(1000); }
    while (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }
  }
}

// graceful
async function shutdown() {
  console.log('shutdown...');
  try { await pool.end(); } catch {}
  try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
