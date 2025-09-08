/* eslint-disable no-console */
/**
 * Search Indexer Worker (OpenSearch / Elasticsearch 7+ compatible)
 *
 * Функции:
 *  - Поднимает индексы/алиасы, создаёт индекс с mapping/template при старте (idempotent).
 *  - Слушает очереди:
 *      q:search.index  — индексировать/реиндексировать { type, id }
 *      q:search.delete — удалить из индекса { type, id }
 *  - type ∈ {'message','post','channel','user'}
 *  - Для каждого типа делает SELECT из Postgres, нормализует поля и кладёт в индекс <prefix>-content
 *
 * ENV:
 *  DB_URL, REDIS_URL
 *  OS_NODE (http://opensearch:9200)
 *  OS_USERNAME, OS_PASSWORD (опционально)
 *  OS_INDEX_PREFIX (default 'app')
 *  STREAM_INDEX='q:search.index', STREAM_DELETE='q:search.delete', GROUP='g:search'
 *  CONCURRENCY=2
 *
 * Стратегия индексации:
 *  - Единый индекс "<prefix>-content-v1" с алиасом "<prefix>-content"
 *  - Поле routing = type для равномерности шардирования
 *  - Документы:
 *    {
 *      id: "<type>:<uuid>",
 *      type: "message|post|channel|user",
 *      tenant_id: "<uuid>" | null,
 *      owner_id: "<uuid>" | null,
 *      created_at: <iso>,
 *      updated_at: <iso>,
 *      text: "<основной текст для поиска>",
 *      tokens: ["разбитые", "токены", "..."],
 *      meta: { ... оригинальные полезные поля ... }
 *    }
 */

import { Client } from '@opensearch-project/opensearch';
import http from 'node:http';
import { Pool } from 'pg';
import Redis from 'ioredis';

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  REDIS_URL = 'redis://redis:6379',

  OS_NODE = 'http://opensearch:9200',
  OS_USERNAME = '',
  OS_PASSWORD = '',
  OS_INDEX_PREFIX = 'app',

  STREAM_INDEX = 'q:search.index',
  STREAM_DELETE = 'q:search.delete',
  GROUP = 'g:search',
  CONCURRENCY = '2',
  PORT = '9092',
} = process.env;

type IndexJob = { type: 'message'|'post'|'channel'|'user'; id: string };
type DeleteJob = IndexJob;

function assertUuid(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('invalid_uuid');
}

const pool = new Pool({
  connectionString: DB_URL,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
  max: 20,
});
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true });

const os = new Client({
  node: OS_NODE,
  auth: OS_USERNAME || OS_PASSWORD ? { username: OS_USERNAME, password: OS_PASSWORD } : undefined,
  ssl: { rejectUnauthorized: false }, // допускаем self-signed на dev
});

const indexNameV = `${OS_INDEX_PREFIX}-content-v1`;
const indexAlias = `${OS_INDEX_PREFIX}-content`;

function routingFor(type: IndexJob['type']) { return type; }
function docId(type: IndexJob['type'], id: string) { return `${type}:${id}`; }

async function ensureIndex() {
  const exists = await os.indices.exists({ index: indexNameV }).then(r => r.body as any).catch(() => false);
  if (!exists) {
    await os.indices.create({
      index: indexNameV,
      body: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: {
            analyzer: {
              text_ru_en: {
                type: 'custom',
                tokenizer: 'standard',
                filter: ['lowercase', 'russian_morphology', 'english_morphology', 'asciifolding'],
              },
            },
          },
        },
        mappings: {
          dynamic: 'strict',
          properties: {
            id: { type: 'keyword' },
            type: { type: 'keyword' },
            tenant_id: { type: 'keyword' },
            owner_id: { type: 'keyword' },
            created_at: { type: 'date' },
            updated_at: { type: 'date' },
            text: { type: 'text', analyzer: 'text_ru_en', term_vector: 'with_positions_offsets' },
            tokens: { type: 'keyword' },
            meta: { type: 'object', enabled: true },
          },
        },
      },
    });
  }

  // alias → на текущий индекс
  const hasAlias = await os.indices.existsAlias({ name: indexAlias }).then(r => r.body as any).catch(() => false);
  if (!hasAlias) {
    await os.indices.putAlias({ index: indexNameV, name: indexAlias });
  }
}

async function selectMessage(id: string) {
  const q = await pool.query(
    `SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at, m.updated_at
       FROM messages m WHERE m.id=$1 LIMIT 1`,
    [id]
  );
  if (!q.rowCount) return null;
  const r = q.rows[0];
  const text = String(r.text || '');
  return {
    id: String(r.id),
    type: 'message' as const,
    tenant_id: null,
    owner_id: String(r.sender_id),
    created_at: r.created_at,
    updated_at: r.updated_at,
    text,
    tokens: splitTokens(text),
    meta: { conversation_id: String(r.conversation_id) },
  };
}

async function selectPost(id: string) {
  const q = await pool.query(
    `SELECT p.id, p.channel_id, p.author_id, p.title, p.body, p.created_at, p.updated_at
       FROM posts p WHERE p.id=$1 LIMIT 1`,
    [id]
  );
  if (!q.rowCount) return null;
  const r = q.rows[0];
  const text = [r.title, r.body].filter(Boolean).map(String).join('\n');
  return {
    id: String(r.id),
    type: 'post' as const,
    tenant_id: null,
    owner_id: String(r.author_id),
    created_at: r.created_at,
    updated_at: r.updated_at,
    text,
    tokens: splitTokens(text),
    meta: { channel_id: String(r.channel_id), title: r.title || null },
  };
}

async function selectChannel(id: string) {
  const q = await pool.query(
    `SELECT c.id, c.slug, c.title, c.description, c.owner_id, c.created_at, c.updated_at
       FROM channels c WHERE c.id=$1 LIMIT 1`,
    [id]
  );
  if (!q.rowCount) return null;
  const r = q.rows[0];
  const text = [r.title, r.description].filter(Boolean).map(String).join('\n');
  return {
    id: String(r.id),
    type: 'channel' as const,
    tenant_id: null,
    owner_id: String(r.owner_id),
    created_at: r.created_at,
    updated_at: r.updated_at,
    text,
    tokens: splitTokens(text),
    meta: { slug: r.slug, title: r.title || null },
  };
}

async function selectUser(id: string) {
  const q = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.bio, u.created_at, u.updated_at
       FROM users u WHERE u.id=$1 LIMIT 1`,
    [id]
  );
  if (!q.rowCount) return null;
  const r = q.rows[0];
  const text = [r.display_name, r.username, r.bio].filter(Boolean).map(String).join('\n');
  return {
    id: String(r.id),
    type: 'user' as const,
    tenant_id: null,
    owner_id: String(r.id),
    created_at: r.created_at,
    updated_at: r.updated_at,
    text,
    tokens: splitTokens(text),
    meta: { username: r.username, display_name: r.display_name || null },
  };
}

async function run() {
  const port = Number(PORT) || 9092;
  startHealthServer(port);
  await ensureIndex();
  // main loop would go here; omitted for brevity, assumed existing logic below
}

run().catch((e) => { console.error('search-indexer fatal', e); process.exit(1); });
function startHealthServer(port: number) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  srv.listen(port, '0.0.0.0');
}

function splitTokens(s: string): string[] {
  return Array.from(new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/g)
      .filter(Boolean)
      .slice(0, 128)
  ));
}

async function indexDoc(job: IndexJob) {
  assertUuid(job.id);
  let doc: any = null;
  if (job.type === 'message') doc = await selectMessage(job.id);
  else if (job.type === 'post') doc = await selectPost(job.id);
  else if (job.type === 'channel') doc = await selectChannel(job.id);
  else if (job.type === 'user') doc = await selectUser(job.id);
  else throw new Error('unsupported_type');

  if (!doc) {
    // нет сущности — удалим из индекса на всякий случай
    await os.delete({
      index: indexAlias,
      id: docId(job.type, job.id),
      routing: routingFor(job.type),
      refresh: 'false',
    }).catch(() => {});
    return;
  }

  await os.index({
    index: indexAlias,
    id: docId(job.type, job.id),
    routing: routingFor(job.type),
    body: doc,
    refresh: 'false',
  });
}

async function deleteDoc(job: DeleteJob) {
  assertUuid(job.id);
  await os.delete({
    index: indexAlias,
    id: docId(job.type, job.id),
    routing: routingFor(job.type),
    refresh: 'false',
  }).catch(() => {});
}

// ────────────────────────────────────────────────────────────────────────────
// Worker loop
// ────────────────────────────────────────────────────────────────────────────
async function ensureGroups() {
  async function ensure(stream: string) {
    try { await redis.xgroup('CREATE', stream, GROUP, '0', 'MKSTREAM'); }
    catch (e: any) { if (!String(e?.message).includes('BUSYGROUP')) throw e; }
  }
  await ensure(STREAM_INDEX);
  await ensure(STREAM_DELETE);
}

function rid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function loop() {
  await ensureIndex();
  await ensureGroups();

  const consumer = `c:${rid()}`;
  const concurrency = Math.max(1, Number(CONCURRENCY) || 2);
  const inflight = new Set<Promise<void>>();

  console.log(`Search Indexer started; alias=${indexAlias}`);

  async function readOnce() {
    // читаем обе очереди конкурентно
    const res = await redis.xreadgroup(
      'GROUP', GROUP, consumer,
      'BLOCK', 5000, 'COUNT', concurrency,
      'STREAMS', STREAM_INDEX, STREAM_DELETE, '>', '>'
    );
    if (!res) return;

    for (const [stream, entries] of res as any[]) {
      for (const [id, fields] of entries) {
        const dataStr = fields?.data || fields?.[1] || '';
        const p = (async () => {
          try {
            const payload = JSON.parse(String(dataStr));
            if (stream === STREAM_INDEX) await indexDoc(payload as IndexJob);
            else await deleteDoc(payload as DeleteJob);
          } catch (err) {
            console.error('search-indexer failed', err);
            await redis.xadd(
              `q:dlq:${stream}`,
              '*',
              'reason', 'processing_failed',
              'error', String((err as Error).message || err),
              'data', String(dataStr)
            );
          } finally {
            await redis.xack(stream, GROUP, id);
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
  console.log('search-indexer: shutdown...');
  try { await pool.end(); } catch {}
  try { await redis.quit(); } catch { try { await redis.disconnect(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop().catch((e) => { console.error('fatal', e); process.exit(1); });
