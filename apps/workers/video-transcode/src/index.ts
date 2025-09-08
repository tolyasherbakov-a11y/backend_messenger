/* eslint-disable no-console */
/**
 * Video Transcoder worker (HLS, multi-renditions)
 * ОБНОВЛЕНО: добавлен AV-гейт — обрабатываем только media с antivirus_status='clean' и quarantined=false.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, createReadStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const pexec = promisify(execFile);

const {
  NODE_ENV = 'production',
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',

  STREAM_NAME = 'q:transcode.video',
  GROUP_NAME = 'g:trans',
  DLQ_STREAM = 'q:dlq:transcode.video',

  // HLS tuning
  HLS_SEGMENT_SECONDS = '4',
  HLS_MAX_VARIANTS = '4',
  BR_360 = '800',
  BR_480 = '1200',
  BR_720 = '2500',
  BR_1080 = '4500',
  A_ACODEC = 'aac',
  A_BR = '128',
  A_SR = '48000',
  THREADS = '2',
  CONCURRENCY = '1',
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
function rid() { return randomUUID(); }

async function ensureGroup() {
  try { await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM'); }
  catch (e: any) { if (!String(e?.message).includes('BUSYGROUP')) throw e; }
}

type Probe = { width: number; height: number; duration: number };
async function ffprobeJson(filePath: string): Promise<Probe> {
  const args = ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', filePath];
  const { stdout } = await pexec('ffprobe', args, { maxBuffer: 5 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const vs = (data.streams || []).find((s: any) => s.codec_type === 'video') || {};
  const dur = Number((data.format?.duration ?? vs.duration ?? 0)) || 0;
  return { width: Number(vs.width || 0), height: Number(vs.height || 0), duration: dur };
}

async function downloadFromS3(key: string, toFile: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
  await fsp.mkdir(dirname(toFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    (res.Body as any).pipe(createWriteStream(toFile)).on('finish', () => resolve()).on('error', reject);
  });
}

async function uploadToS3(key: string, fromFile: string, contentType?: string) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key, Body: createReadStream(fromFile), ContentType: contentType || undefined }));
}

async function objectExists(key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key })); return true; }
  catch { return false; }
}

type Rendition = { profile: '360p'|'480p'|'720p'|'1080p', height: number, width: number, vbrKbps: number };
function selectRenditions(srcW: number, srcH: number): Rendition[] {
  const all: Rendition[] = [
    { profile: '360p',  height: 360,  width: Math.round(360 * (srcW/srcH) / 2) * 2 || 640,  vbrKbps: Number(BR_360) },
    { profile: '480p',  height: 480,  width: Math.round(480 * (srcW/srcH) / 2) * 2 || 854,  vbrKbps: Number(BR_480) },
    { profile: '720p',  height: 720,  width: Math.round(720 * (srcW/srcH) / 2) * 2 || 1280, vbrKbps: Number(BR_720) },
    { profile: '1080p', height: 1080, width: Math.round(1080 * (srcW/srcH) / 2) * 2 || 1920, vbrKbps: Number(BR_1080) },
  ];
  const maxVariants = Math.max(1, Math.min(4, Number(HLS_MAX_VARIANTS) || 4));
  return all.filter(r => r.height <= srcH + 8).slice(0, maxVariants);
}

async function runFfmpegHls(srcFile: string, outDir: string, r: Rendition) {
  await fsp.mkdir(outDir, { recursive: true });
  const segDur = Number(HLS_SEGMENT_SECONDS) || 4;
  const args = [
    '-y',
    '-i', srcFile,
    '-threads', String(THREADS),
    '-vf', `scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease:flags=bicubic`,
    '-c:v', 'h264', '-profile:v', 'high', '-level', '4.1',
    '-preset', 'veryfast',
    '-b:v', `${r.vbrKbps}k`,
    '-maxrate', `${Math.round(r.vbrKbps*1.45)}k`,
    '-bufsize', `${Math.round(r.vbrKbps*3)}k`,
    '-g', String(segDur*2*30),
    '-keyint_min', String(segDur*30),
    '-c:a', A_ACODEC, '-b:a', `${A_BR}k`, '-ar', A_SR,
    '-hls_time', String(segDur),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(outDir, 'seg_%05d.ts'),
    '-hls_flags', 'independent_segments',
    join(outDir, 'index.m3u8'),
  ];
  await pexec('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });
}

async function writeMaster(masterPath: string, renditions: Rendition[]) {
  const lines: string[] = ['#EXTM3U'];
  for (const r of renditions) {
    const avgBw = (r.vbrKbps + Number(A_BR)) * 1000;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${avgBw},RESOLUTION=${r.width}x${r.height},CODECS="avc1.640029,mp4a.40.2"`,
      `${r.profile}/index.m3u8`
    );
  }
  await fsp.mkdir(dirname(masterPath), { recursive: true });
  await fsp.writeFile(masterPath, lines.join('\n'), 'utf8');
}

async function upsertVariant(mediaId: string, profile: string, storageKey: string, width: number, height: number, durationSec: number, vbrKbps: number) {
  await pool.query(
    `INSERT INTO media_variants (media_id, profile, storage_key, width, height, duration_ms, bitrate_kbps)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (media_id, profile)
     DO UPDATE SET storage_key=EXCLUDED.storage_key,width=EXCLUDED.width,height=EXCLUDED.height,
                   duration_ms=EXCLUDED.duration_ms,bitrate_kbps=EXCLUDED.bitrate_kbps,updated_at=now_utc()`,
    [mediaId, profile, storageKey, width, height, Math.round(durationSec*1000), vbrKbps]
  );
}

async function processJob(job: Job) {
  if (!job?.mediaId || !job?.storageKey) throw new Error('bad_job');

  // ── AV-гейт ────────────────────────────────────────────────────────────────
  const st = await pool.query(
    `SELECT antivirus_status, quarantined FROM media_files WHERE id=$1 LIMIT 1`,
    [job.mediaId]
  );
  if (!st.rowCount) throw new Error('media_not_found');
  const { antivirus_status, quarantined } = st.rows[0] as { antivirus_status: string; quarantined: boolean };
  if (quarantined || antivirus_status !== 'clean') {
    console.log(`skip transcode media=${job.mediaId} status=${antivirus_status} quarantined=${quarantined}`);
    return; // мягко игнорим — корректную задачу опубликует AV-воркер при clean
  }

  // если уже есть варианты — считаем завершённым
  const already = await pool.query(`SELECT 1 FROM media_variants WHERE media_id=$1 AND profile LIKE 'vid_%' LIMIT 1`, [job.mediaId]);
  if (already.rowCount) { console.log(`variants exist; skip media=${job.mediaId}`); return; }

  if (!(await objectExists(job.storageKey))) throw new Error(`s3_missing:${job.storageKey}`);

  const workId = randomUUID();
  const workDir = join(tmpdir(), `trans-${workId}`);
  const srcFile = join(workDir, 'source');
  await fsp.mkdir(workDir, { recursive: true });
  await downloadFromS3(job.storageKey, srcFile);

  const meta = await ffprobeJson(srcFile);
  if (!meta.width || !meta.height) throw new Error('ffprobe_no_dims');

  const renditions = selectRenditions(meta.width, meta.height);
  if (renditions.length === 0) throw new Error('no_renditions');

  const outputs: Array<{ profile: Rendition['profile']; dir: string; w: number; h: number }> = [];
  for (const r of renditions) {
    const outDir = join(workDir, r.profile);
    await runFfmpegHls(srcFile, outDir, r);
    outputs.push({ profile: r.profile, dir: outDir, w: r.width, h: r.height });
  }

  const masterLocal = join(workDir, 'master.m3u8');
  await writeMaster(masterLocal, renditions);

  const basePrefix = `variants/${job.mediaId}/hls`;
  for (const out of outputs) {
    await uploadToS3(`${basePrefix}/${out.profile}/index.m3u8`, join(out.dir, 'index.m3u8'), 'application/vnd.apple.mpegurl');
    const files = await fsp.readdir(out.dir);
    for (const f of files) {
      if (f === 'index.m3u8') continue;
      await uploadToS3(`${basePrefix}/${out.profile}/${f}`, join(out.dir, f), f.endsWith('.ts') ? 'video/mp2t' : undefined);
    }
  }
  await uploadToS3(`${basePrefix}/master.m3u8`, masterLocal, 'application/vnd.apple.mpegurl');

  for (const r of renditions) {
    await upsertVariant(job.mediaId, `vid_${r.profile}_hls`, `${basePrefix}/${r.profile}/index.m3u8`, r.width, r.height, meta.duration, r.vbrKbps);
  }

  await fsp.rm(workDir, { recursive: true, force: true });
  console.log(`transcode complete media=${job.mediaId} renditions=${renditions.map(r=>r.profile).join(',')}`);
}

async function loop() {
  await ensureGroup();
  const consumer = `c:${rid()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 1);
  const inflight = new Set<Promise<void>>();

  console.log(`Video-Transcoder started; stream=${STREAM_NAME} group=${GROUP_NAME}`);

  async function readOnce() {
    const res = await redis.xreadgroup('GROUP', GROUP_NAME, consumer, 'BLOCK', 5000, 'COUNT', concurrency, 'STREAMS', STREAM_NAME, '>');
    if (!res) return;
    for (const [, entries] of res as any[]) {
      for (const [id, fields] of entries as any[]) {
        const dataStr = fields?.data || fields?.[1] || '';
        let payload: Job | null = null;
        try { payload = JSON.parse(String(dataStr)); }
        catch { await redis.xack(STREAM_NAME, GROUP_NAME, id); await redis.xadd(DLQ_STREAM, '*', 'reason', 'bad_json', 'data', String(dataStr)); continue; }

        const p = (async () => {
          try { await processJob(payload!); await redis.xack(STREAM_NAME, GROUP_NAME, id); }
          catch (err) {
            console.error('transcode failed', err);
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

async function shutdown() {
  console.log('shutdown...');
  try { await pool.end(); } catch {}
  try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop().catch((e) => { console.error('fatal', e); process.exit(1); });
