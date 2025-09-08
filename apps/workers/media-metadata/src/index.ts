/* eslint-disable no-console */
/**
 * Media Metadata worker
 * - Берёт задания из Redis Stream q:metadata.media (group g:meta)
 *   payload: { mediaId: string, storageKey: string, mime?: string }
 * - Скачивает файл из S3 → считает SHA-256 и CRC32 (на 4 МБ превью), определяет MIME,
 *   извлекает метаданные (ffprobe для audio/video, exiftool для image/other).
 * - Пишет/обновляет media_metadata (mime_detected, bytes, sha256, crc32, meta jsonb).
 * - Если в media_files.sha256 ПУСТО — записывает вычисленное; если ЗАПОЛНЕНО и не совпало —
 *     помечает запись: quarantined=true, antivirus_status='error', отправляет событие в DLQ и завершает.
 * - (Опционально) если media_files.mime пустой/октет — обновляет на mime_detected.
 *
 * ENV:
 *  DB_URL, REDIS_URL
 *  S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_PRIVATE
 *  STREAM_NAME=q:metadata.media, GROUP_NAME=g:meta, DLQ_STREAM=q:dlq:metadata.media
 *  CONCURRENCY=2, TMP_DIR
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import fileType from 'file-type';
import { exiftool } from 'exiftool-vendored';

const pexec = promisify(execFile);

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',

  STREAM_NAME = 'q:metadata.media',
  GROUP_NAME = 'g:meta',
  DLQ_STREAM = 'q:dlq:metadata.media',

  CONCURRENCY = '2',
  TMP_DIR = '',
} = process.env;

type Job = { mediaId: string; storageKey: string; mime?: string };

const pool = new Pool({
  connectionString: DB_URL,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
  max: 10,
});
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
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
  try { await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM'); }
  catch (e: any) { if (!String(e?.message).includes('BUSYGROUP')) throw e; }
}

async function s3Exists(key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key })); return true; }
  catch { return false; }
}

async function downloadToTmp(key: string): Promise<{ path: string; bytes: number }> {
  const dir = join(TMP_DIR || tmpdir(), `meta-${randomUUID()}`);
  const file = join(dir, 'object.bin');
  await fsp.mkdir(dir, { recursive: true });
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    (resp.Body as any)
      .on('data', (chunk: Buffer) => { bytes += chunk.length; })
      .pipe(createWriteStream(file))
      .on('finish', () => resolve())
      .on('error', reject);
  });
  return { path: file, bytes };
}

async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (c) => h.update(c as Buffer))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

function crc32(buffer: Buffer): number {
  let c = 0 ^ (-1);
  for (let i = 0; i < buffer.length; i++) c = (c >>> 8) ^ table[(c ^ buffer[i]) & 0xff];
  return (c ^ (-1)) >>> 0;
}
const table = (() => {
  const t = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

async function detectMime(filePath: string, hinted?: string): Promise<string> {
  // пробуем по магическим байтам
  const detected = await fileType.fromFile(filePath).catch(() => null);
  if (detected?.mime) return detected.mime;
  // fallback: exiftool
  try {
    const ex = await exiftool.read(filePath);
    if (typeof ex.MIMEType === 'string' && ex.MIMEType) return String(ex.MIMEType);
  } catch {}
  return hinted || 'application/octet-stream';
}

function isVideo(m: string) { return /^video\//i.test(m); }
function isAudio(m: string) { return /^audio\//i.test(m); }
function isImage(m: string) { return /^image\//i.test(m); }

async function ffprobeJson(filePath: string): Promise<any> {
  const args = ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', filePath];
  const { stdout } = await pexec('ffprobe', args, { maxBuffer: 5 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function extractMeta(filePath: string, mime: string): Promise<any> {
  if (isVideo(mime) || isAudio(mime)) {
    const p = await ffprobeJson(filePath);
    const fmt = p.format || {};
    const streams = (p.streams || []).map((s: any) => ({
      codec_type: s.codec_type,
      codec_name: s.codec_name,
      width: s.width ?? null,
      height: s.height ?? null,
      channels: s.channels ?? null,
      sample_rate: s.sample_rate ?? null,
      bit_rate: s.bit_rate ? Number(s.bit_rate) : null,
      avg_frame_rate: s.avg_frame_rate ?? null,
      duration: s.duration ? Number(s.duration) : null,
    }));
    return {
      type: isVideo(mime) ? 'video' : 'audio',
      duration: fmt.duration ? Number(fmt.duration) : (streams.find((x: any) => x.duration)?.duration ?? null),
      bit_rate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
      streams,
      tags: fmt.tags || null,
    };
  }

  const ex = await exiftool.read(filePath);
  const imageW = (ex.ImageWidth ?? ex.ExifImageWidth ?? ex.PixelXDimension) as number | undefined;
  const imageH = (ex.ImageHeight ?? ex.ExifImageHeight ?? ex.PixelYDimension) as number | undefined;
  const orientation = ex.Orientation as string | undefined;
  const dateTaken = (ex.DateTimeOriginal || ex.CreateDate || ex.ModifyDate) as string | undefined;
  const gps = (ex.GPSLatitude && ex.GPSLongitude) ? { lat: ex.GPSLatitude, lon: ex.GPSLongitude, altitude: ex.GPSAltitude ?? null } : null;

  return {
    type: isImage(mime) ? 'image' : 'binary',
    width: imageW ?? null,
    height: imageH ?? null,
    orientation: orientation ?? null,
    dateTaken: dateTaken ?? null,
    gps,
    colorSpace: ex.ColorSpace || null,
    exif: {
      Make: ex.Make || null,
      Model: ex.Model || null,
      LensModel: ex.LensModel || null,
      Software: ex.Software || null,
      ExposureTime: ex.ExposureTime || null,
      FNumber: ex.FNumber || null,
      ISO: ex.ISO || null,
      FocalLength: ex.FocalLength || null,
    },
  };
}

async function upsertMetadata(mediaId: string, mimeDetected: string, bytes: number, sha256: string, crc32v: number, meta: any) {
  await pool.query(
    `INSERT INTO media_metadata (media_id, mime_detected, bytes, sha256, crc32, meta, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, now_utc())
     ON CONFLICT (media_id) DO UPDATE SET
       mime_detected=EXCLUDED.mime_detected, bytes=EXCLUDED.bytes,
       sha256=EXCLUDED.sha256, crc32=EXCLUDED.crc32, meta=EXCLUDED.meta,
       scanned_at=now_utc(), updated_at=now_utc()`,
    [mediaId, mimeDetected, bytes, sha256, crc32v, JSON.stringify(meta)]
  );
}

async function maybeUpdateMime(mediaId: string, mimeDetected: string) {
  const q = await pool.query(`SELECT mime FROM media_files WHERE id=$1 LIMIT 1`, [mediaId]);
  if (!q.rowCount) return;
  const current = String(q.rows[0].mime || '');
  if (!current || current === 'application/octet-stream' || current.toLowerCase() !== mimeDetected.toLowerCase()) {
    await pool.query(`UPDATE media_files SET mime=$2, updated_at=now_utc() WHERE id=$1`, [mediaId, mimeDetected]);
  }
}

async function writeShaIfEmptyOrQuarantineOnMismatch(mediaId: string, shaCalculated: string): Promise<'ok'|'quarantined'> {
  const q = await pool.query(`SELECT sha256 FROM media_files WHERE id=$1 LIMIT 1`, [mediaId]);
  if (!q.rowCount) throw new Error('media_not_found');
  const stored = q.rows[0].sha256 as string | null;

  if (!stored) {
    await pool.query(`UPDATE media_files SET sha256=$2, updated_at=now_utc() WHERE id=$1`, [mediaId, shaCalculated]);
    return 'ok';
  }
  if (stored.toLowerCase() !== shaCalculated.toLowerCase()) {
    await pool.query(
      `UPDATE media_files SET quarantined=true, antivirus_status='error', updated_at=now_utc() WHERE id=$1`,
      [mediaId]
    );
    return 'quarantined';
  }
  return 'ok';
}

async function processJob(job: Job) {
  if (!job?.mediaId || !job?.storageKey) throw new Error('bad_job');
  if (!(await s3Exists(job.storageKey))) throw new Error(`s3_missing:${job.storageKey}`);

  // качаем
  const { path: local, bytes } = await downloadToTmp(job.storageKey);

  try {
    // sha256
    const sha = await sha256File(local);

    // сверка/запись sha256 в media_files
    const shaState = await writeShaIfEmptyOrQuarantineOnMismatch(job.mediaId, sha);
    if (shaState === 'quarantined') {
      // в DLQ — чтобы отследить инцидент
      await redis.xadd(
        DLQ_STREAM, '*',
        'reason', 'sha_mismatch',
        'data', JSON.stringify({ mediaId: job.mediaId, storageKey: job.storageKey, shaCalculated: sha })
      );
      console.error(`metadata: sha mismatch → quarantined media=${job.mediaId}`);
      return;
    }

    // crc32 (на первых 4 МБ)
    const take = Math.min(bytes, 4 * 1024 * 1024);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let got = 0;
      const rs = createReadStream(local, { start: 0, end: take - 1 });
      rs.on('data', (c) => { chunks.push(c as Buffer); got += (c as Buffer).length; });
      rs.on('end', () => resolve(Buffer.concat(chunks, got)));
      rs.on('error', reject);
    });
    const crc = crc32(buf);

    // mime
    const mime = await detectMime(local, job.mime);

    // метаданные
    const meta = await extractMeta(local, mime);

    // UPSERT в media_metadata
    await upsertMetadata(job.mediaId, mime, bytes, sha, crc, meta);

    // возможно проставим более точный MIME в media_files
    await maybeUpdateMime(job.mediaId, mime);

    console.log(`metadata OK media=${job.mediaId} mime=${mime} bytes=${bytes}`);
  } finally {
    try { await fsp.rm(dirname(local), { recursive: true, force: true }); } catch {}
  }
}

async function loop() {
  await ensureGroup();
  const consumer = `c:${rid()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 2);
  const inflight = new Set<Promise<void>>();

  console.log(`Media Metadata started; stream=${STREAM_NAME} group=${GROUP_NAME}`);

  async function readOnce() {
    const res = await redis.xreadgroup('GROUP', GROUP_NAME, consumer, 'BLOCK', 5000, 'COUNT', concurrency, 'STREAMS', STREAM_NAME, '>');
    if (!res) return;
    for (const [, entries] of res as any[]) {
      for (const [id, fields] of entries as any[]) {
        const dataStr = fields?.data || fields?.[1] || '';
        let payload: Job | null = null;
        try { payload = JSON.parse(String(dataStr)); }
        catch { await redis.xack(STREAM_NAME, GROUP_NAME, id); await redis.xadd(DLQ_STREAM, '*', 'reason','bad_json','data', String(dataStr)); continue; }

        const p = (async () => {
          try { await processJob(payload!); await redis.xack(STREAM_NAME, GROUP_NAME, id); }
          catch (err) {
            console.error('metadata failed', err);
            await redis.xack(STREAM_NAME, GROUP_NAME, id);
            await redis.xadd(DLQ_STREAM, '*', 'reason','processing_failed','error', String((err as Error).message || err),'data', JSON.stringify(payload));
          }
        })().finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await readOnce(); } catch (e) { console.error('read loop error', e); await sleep(1000); }
    while (inflight.size >= concurrency) await Promise.race(inflight);
  }
}

// graceful
async function shutdown() {
  console.log('metadata: shutdown...');
  try { await exiftool.end(); } catch {}
  try { await pool.end(); } catch {}
  try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop().catch((e) => { console.error('fatal', e); process.exit(1); });
