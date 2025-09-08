/* eslint-disable no-console */
/**
 * Realtime WebSocket Gateway
 *
 * Функции:
 *  - WS /ws — авторизация по Bearer (JWT или HMAC), привязка к userId
 *  - Управление подписками на топики (user, conv:<id>, channel:<id>, feed)
 *  - Автоподписка: user:<userId> + активные беседы и подписанные каналы (из БД)
 *  - Хартбит/пинг, защита от флуд-подписок, graceful shutdown
 *  - Мультиплекс: Redis Pub/Sub → локальные WebSocket клиенты по топику
 *
 * Топики Redis Pub/Sub:
 *  - rt:user:<userId>
 *  - rt:conv:<conversationId>
 *  - rt:channel:<channelId>
 *  - rt:feed
 *
 * Формат publish-сообщений (JSON):
 *  { "event": "message:new", "topic": "rt:conv:<id>", "ts": 1700000000000, "data": {...} }
 *
 * ENV:
 *  PORT (default 8080)
 *  REDIS_URL (redis://...)
 *  DB_URL (Postgres; для автоподписок)
 *  AUTH_JWT_SECRET  — если используете JWT (HS256)
 *  AUTH_HMAC_SECRET — альтернативно, HMAC подпись X-Timestamp:X-User-Id (см. verifyHmacAuth)
 *  WS_MAX_SUBS (default 200)
 *  WS_PING_INTERVAL_MS (default 25000)
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const {
  PORT = '8080',
  REDIS_URL = 'redis://redis:6379',
  DB_URL = 'postgres://app:app@postgres:5432/app',
  AUTH_JWT_SECRET = '',
  AUTH_HMAC_SECRET = '',
  WS_MAX_SUBS = '200',
  WS_PING_INTERVAL_MS = '25000',
} = process.env;

type AuthedUser = { id: string };
type ClientMsg =
  | { action: 'subscribe'; topics: string[] }
  | { action: 'unsubscribe'; topics: string[] }
  | { action: 'ping' };
type ServerMsg =
  | { ok: true; type: 'welcome'; userId: string }
  | { ok: true; type: 'subscribed'; topics: string[] }
  | { ok: true; type: 'unsubscribed'; topics: string[] }
  | { ok: true; type: 'pong'; ts: number }
  | { ok: false; error: string }
  | { event: string; topic: string; ts: number; data: any };

const app = Fastify({ logger: false });
await app.register(websocket, { options: { clientTracking: false } });

const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const pool = new Pool({
  connectionString: DB_URL,
  statement_timeout: 8000,
  idle_in_transaction_session_timeout: 8000,
  max: 10,
});

// ────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ────────────────────────────────────────────────────────────────────────────
function isUuid(id: string) { return /^[0-9a-f-]{36}$/i.test(id); }

function verifyJwtAuth(header?: string): AuthedUser | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  if (!AUTH_JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, AUTH_JWT_SECRET) as any;
    const uid = String(payload.sub || payload.userId || payload.uid || '');
    if (!isUuid(uid)) return null;
    return { id: uid };
  } catch { return null; }
}

function verifyHmacAuth(headers: Record<string, any>): AuthedUser | null {
  if (!AUTH_HMAC_SECRET) return null;
  const uid = String(headers['x-user-id'] || '');
  const ts = String(headers['x-timestamp'] || '');
  const sig = String(headers['x-signature'] || '');
  if (!uid || !isUuid(uid) || !ts || !sig) return null;
  const base = `${uid}:${ts}`;
  const expected = crypto.createHmac('sha256', AUTH_HMAC_SECRET).update(base).digest('hex');
  if (expected !== sig) return null;
  const skew = Math.abs(Date.now() - Number(ts));
  if (isNaN(skew) || skew > 5 * 60 * 1000) return null; // 5m
  return { id: uid };
}

// ────────────────────────────────────────────────────────────────────────────
// Topic registry & Redis subscription management
// ────────────────────────────────────────────────────────────────────────────
type SocketCtx = {
  userId: string;
  ws: WebSocket;
  subs: Set<string>;
  lastPongAt: number;
};

const topicToSockets = new Map<string, Set<SocketCtx>>();
const topicRefCount = new Map<string, number>();
const sockets = new Set<SocketCtx>();

function isAllowedTopic(s: string): boolean {
  return s === 'rt:feed' ||
         /^rt:user:[0-9a-f-]{36}$/i.test(s) ||
         /^rt:conv:[0-9a-f-]{36}$/i.test(s) ||
         /^rt:channel:[0-9a-f-]{36}$/i.test(s);
}

async function redisSubscribe(topic: string) {
  if (!topicRefCount.has(topic)) {
    await sub.subscribe(topic);
    topicRefCount.set(topic, 1);
  } else {
    topicRefCount.set(topic, (topicRefCount.get(topic) || 0) + 1);
  }
}

async function redisUnsubscribe(topic: string) {
  const n = (topicRefCount.get(topic) || 0) - 1;
  if (n <= 0) {
    topicRefCount.delete(topic);
    try { await sub.unsubscribe(topic); } catch {}
  } else {
    topicRefCount.set(topic, n);
  }
}

sub.on('message', (_channel, message) => {
  let msg: ServerMsg | null = null;
  try { msg = JSON.parse(message); } catch { return; }
  if (!msg || typeof (msg as any).topic !== 'string') return;
  const topic = (msg as any).topic as string;
  const set = topicToSockets.get(topic);
  if (!set || set.size === 0) return;
  for (const ctx of Array.from(set)) {
    try { ctx.ws.send(JSON.stringify(msg)); } catch {}
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap auto-subscriptions from DB
// ────────────────────────────────────────────────────────────────────────────
async function preloadUserTopics(userId: string): Promise<string[]> {
  const topics = new Set<string>();
  topics.add(`rt:user:${userId}`);

  try {
    // Активные беседы
    const convs = await pool.query(
      `SELECT conversation_id AS id
         FROM conversation_members
        WHERE user_id = $1 AND left_at IS NULL
        LIMIT 500`,
      [userId]
    );
    for (const r of convs.rows) {
      topics.add(`rt:conv:${String(r.id)}`);
    }

    // Подписанные каналы
    const ch = await pool.query(
      `SELECT channel_id AS id
         FROM channel_follows
        WHERE user_id = $1
        LIMIT 500`,
      [userId]
    );
    for (const r of ch.rows) {
      topics.add(`rt:channel:${String(r.id)}`);
    }
  } catch (e) {
    console.warn('preload topics failed', e);
  }

  return Array.from(topics);
}

// ────────────────────────────────────────────────────────────────────────────
app.register(async (f) => {
  f.get('/healthz', async () => ({ ok: true }));

  f.get('/ws', { websocket: true }, async (conn, req) => {
    // Auth
    const user =
      verifyJwtAuth(String(req.headers.authorization || '')) ||
      verifyHmacAuth(req.headers as any);

    if (!user) {
      try { (conn.socket as WebSocket).close(4401, 'unauthorized'); } catch {}
      return;
    }

    const ws = conn.socket as WebSocket;
    const ctx: SocketCtx = { userId: user.id, ws, subs: new Set(), lastPongAt: Date.now() };
    sockets.add(ctx);

    // Autoload initial topics
    const initTopics = await preloadUserTopics(user.id);
    const maxSubs = Math.max(1, Number(WS_MAX_SUBS) || 200);
    for (const t of initTopics.slice(0, maxSubs)) {
      await redisSubscribe(t);
      ctx.subs.add(t);
      if (!topicToSockets.has(t)) topicToSockets.set(t, new Set());
      topicToSockets.get(t)!.add(ctx);
    }

    ws.send(JSON.stringify({ ok: true, type: 'welcome', userId: user.id } satisfies ServerMsg));

    ws.on('message', async (buf) => {
      let msg: ClientMsg | null = null;
      try { msg = JSON.parse(String(buf)); } catch {
        ws.send(JSON.stringify({ ok: false, error: 'bad_json' } satisfies ServerMsg));
        return;
      }

      if (!msg || typeof (msg as any).action !== 'string') {
        ws.send(JSON.stringify({ ok: false, error: 'bad_payload' } satisfies ServerMsg));
        return;
      }

      if (msg.action === 'ping') {
        ctx.lastPongAt = Date.now();
        ws.send(JSON.stringify({ ok: true, type: 'pong', ts: Date.now() } satisfies ServerMsg));
        return;
      }

      if ((msg.action === 'subscribe' || msg.action === 'unsubscribe') && Array.isArray(msg.topics)) {
        const want = [...new Set(msg.topics.filter(isAllowedTopic))];
        if (want.length === 0) {
          ws.send(JSON.stringify({ ok: false, error: 'no_topics' } satisfies ServerMsg));
          return;
        }

        if (msg.action === 'subscribe') {
          // лимит
          if (ctx.subs.size + want.length > maxSubs) {
            ws.send(JSON.stringify({ ok: false, error: 'too_many_subscriptions' } satisfies ServerMsg));
            return;
          }
          for (const t of want) {
            if (ctx.subs.has(t)) continue;
            await redisSubscribe(t);
            ctx.subs.add(t);
            if (!topicToSockets.has(t)) topicToSockets.set(t, new Set());
            topicToSockets.get(t)!.add(ctx);
          }
          ws.send(JSON.stringify({ ok: true, type: 'subscribed', topics: want } satisfies ServerMsg));
        } else {
          for (const t of want) {
            if (!ctx.subs.has(t)) continue;
            ctx.subs.delete(t);
            topicToSockets.get(t)?.delete(ctx);
            if ((topicToSockets.get(t)?.size || 0) === 0) topicToSockets.delete(t);
            await redisUnsubscribe(t);
          }
          ws.send(JSON.stringify({ ok: true, type: 'unsubscribed', topics: want } satisfies ServerMsg));
        }
        return;
      }

      ws.send(JSON.stringify({ ok: false, error: 'unsupported_action' } satisfies ServerMsg));
    });

    ws.on('close', async () => {
      sockets.delete(ctx);
      // отписка всех топиков
      for (const t of ctx.subs) {
        topicToSockets.get(t)?.delete(ctx);
        if ((topicToSockets.get(t)?.size || 0) === 0) topicToSockets.delete(t);
        await redisUnsubscribe(t);
      }
      ctx.subs.clear();
    });
  });
});

// Ping timer
const interval = setInterval(() => {
  const now = Date.now();
  for (const ctx of sockets) {
    try {
      if (now - ctx.lastPongAt > Number(WS_PING_INTERVAL_MS) * 2) {
        ctx.ws.terminate();
        continue;
      }
      ctx.ws.send(JSON.stringify({ ok: true, type: 'pong', ts: now } satisfies ServerMsg));
    } catch {
      try { ctx.ws.terminate(); } catch {}
    }
  }
}, Math.max(10_000, Number(WS_PING_INTERVAL_MS) || 25_000));

// graceful shutdown
async function shutdown() {
  console.log('realtime: shutdown...');
  clearInterval(interval);
  try { for (const ctx of sockets) { try { ctx.ws.close(1001, 'server_shutdown'); } catch {} } } catch {}
  try { await pool.end(); } catch {}
  try { await sub.quit(); } catch { try { await sub.disconnect(); } catch {} }
  try { await pub.quit(); } catch { try { await pub.disconnect(); } catch {} }
  try { await app.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port: Number(PORT), host: '0.0.0.0' })
  .then(() => console.log(`Realtime WS listening on :${PORT}`))
  .catch((e) => { console.error('listen failed', e); process.exit(1); });
