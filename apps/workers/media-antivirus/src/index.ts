/* eslint-disable no-console */
/**
 * Media Antivirus worker (clamd INSTREAM)
 * ОБНОВЛЕНО: после clean публикует задачи variants/transcode в зависимости от MIME.
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY = 'minioadmin',
  S3_SECRET_KEY = 'minioadmin',
  S3_BUCKET_PRIVATE = 'media',

  CLAMAV_HOST = 'clamd',
  CLAMAV_PORT = '3310',
  CLAMAV_TIMEOUT_MS = '15000',

  STREAM_NAME = 'q:antivirus.media',
  GROUP_NAME = 'g:av',
  DLQ_STREAM = 'q:dlq:antivirus.media',

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

async function downloadToTmp(key: string): Promise<string> {
  const work = join(TMP_DIR || tmpdir(), `av-${randomUUID()}`);
  const file = join(work, 'object.bin');
  await fsp.mkdir(work, { recursive: true });
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET_PRIVATE, Key: key }));
  await new Promise<void>((resolve, reject) => {
    (resp.Body as any).pipe(createWriteStream(file)).on('finish', () => resolve()).on('error', reject);
  });
  return file;
}

type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'error'; error: string };

async function scanWithClamd(filePath: string): Promise<ScanResult> {
  const host = CLAMAV_HOST; const port = Number(CLAMAV_PORT) || 3310; const timeout = Math.max(1000, Number(CLAMAV_TIMEOUT_MS) || 15000);
  return new Promise<ScanResult>((resolve) => {
    const socket = new net.Socket(); let done = false;
    const finish = (r: ScanResult) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve(r); };
    const t = setTimeout(() => finish({ status: 'error', error: 'clamd_timeout' }), timeout);
    socket.on('error', (err) => { clearTimeout(t); finish({ status: 'error', error: `clamd_socket_error:${String(err.message||err)}` }); });
    socket.connect(port, host, async () => {
      try {
        socket.write('INSTREAM\0');
        const rs = createReadStream(filePath, { highWaterMark: 64*1024 });
        for await (const chunk of rs) {
          const len = Buffer.alloc(4); len.writeUInt32BE((chunk as Buffer).length, 0);
          socket.write(len); socket.write(chunk as Buffer);
        }
        const zero = Buffer.alloc(4); zero.writeUInt32BE(0,0); socket.write(zero);
        let data=''; socket.on('data',(b)=>{ data+=b.toString('utf8'); });
        socket.on('end',()=>{ clearTimeout(t); const line=data.trim();
          if (/OK$/.test(line)) return finish({ status:'clean' });
          const m=line.match(/(.+)\s+FOUND$/i); if (m) return finish({ status:'infected', signature:m[1].trim() });
          return finish({ status:'error', error:`clamd_unknown_response:${line}` });
        });
        socket.end();
      } catch (e:any) { clearTimeout(t); finish({ status:'error', error:`clamd_stream_error:${String(e.message||e)}` }); }
    });
  });
}

async function updateStatus(mediaId: string, res: ScanResult) {
  switch (res.status) {
    case 'clean':
      await pool.query(
        `UPDATE media_files SET antivirus_status='clean', quarantined=false, antivirus_scanned_at=now_utc(), updated_at=now_utc() WHERE id=$1`,
        [mediaId]
      );
      break;
    case 'infected':
      await pool.query(
        `UPDATE media_files SET antivirus_status='infected', quarantined=true, antivirus_scanned_at=now_utc(), updated_at=now_utc() WHERE id=$1`,
        [mediaId]
      );
      break;
    case 'error':
      await pool.query(
        `UPDATE media_files SET antivirus_status='error', quarantined=true, antivirus_scanned_at=now_utc(), updated_at=now_utc() WHERE id=$1`,
        [mediaId]
      );
      break;
  }
}

async function publishFollowupsIfClean(mediaId: string) {
  // Узнаём MIME из БД (наиболее достоверный на текущий момент)
  const q = await pool.query(`SELECT mime, storage_key FROM media_files WHERE id=$1 LIMIT 1`, [mediaId]);
  if (!q.rowCount) return;
  const mime = String(q.rows[0].mime || '');
  const storageKey = String(q.rows[0].storage_key || '');
  if (!mime || !storageKey) return;

  // Публикуем только если действительно clean
  const st = await pool.query(`SELECT antivirus_status, quarantined FROM media_files WHERE id=$1 LIMIT 1`, [mediaId]);
  if (!st.rowCount) return;
  const { antivirus_status, quarantined } = st.rows[0] as { antivirus_status: string; quarantined: boolean };
  if (quarantined || antivirus_status !== 'clean') return;

  if (/^image\//i.test(mime)) {
    await redis.xadd('q:variants.image', '*', 'data', JSON.stringify({ mediaId, storageKey, mime }));
  } else if (/^video\//i.test(mime)) {
    await redis.xadd('q:transcode.video', '*', 'data', JSON.stringify({ mediaId, storageKey, mime }));
  }
}

async function processJob(job: Job) {
  if (!job?.mediaId || !job?.storageKey) throw new Error('bad_job');

  // если объект в S3 ещё не виден — это наш случай eventual; лучше бросить ошибку в DLQ? Сканируем только если есть
  if (!(await s3Exists(job.storageKey))) throw new Error(`s3_missing:${job.storageKey}`);

  const local = await downloadToTmp(job.storageKey);
  try {
    const res = await scanWithClamd(local);
    await updateStatus(job.mediaId, res);

    if (res.status === 'clean') {
      console.log(`av clean media=${job.mediaId}`);
      // важная часть: публикация последующих задач
      await publishFollowupsIfClean(job.mediaId);
    } else if (res.status === 'infected') {
      console.warn(`av infected media=${job.mediaId} signature=${res.signature}`);
    } else {
      console.error(`av error media=${job.mediaId} err=${res.error}`);
    }
  } finally {
    try { await fsp.rm(dirname(local), { recursive: true, force: true }); } catch {}
  }
}

async function loop() {
  await ensureGroup();
  const consumer = `c:${rid()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 2);
  const inflight = new Set<Promise<void>>();

  console.log(`Media Antivirus started; stream=${STREAM_NAME} group=${GROUP_NAME}`);

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
            console.error('antivirus failed', err);
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
