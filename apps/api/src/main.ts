/**
 * Боевой Fastify API (HTTP + WS) с security, CORS, rate-limit, health/ready,
 * Swagger и корректным graceful shutdown. Подключает v1Routes под префиксом /v1.
 */
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import metricsPlugin from './plugins/metrics';
import { registerOpenAPI } from './plugins/openapi';
import { registerValidation } from './plugins/validation';
import { registerSecurity } from './plugins/security';
import { registerRateLimit } from './plugins/ratelimit';

import { Pool } from 'pg';
import Redis from 'ioredis';

// V1 агрегатор
import v1Routes from './routes/v1/index';

// ──────────────────────────────────────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────────────────────────────────────
const {
  NODE_ENV = 'production',
  PORT = '8080',
  PUBLIC_URL = '',
  // DB
  DB_URL = 'postgres://app:app@postgres:5432/app',
  DB_STATEMENT_TIMEOUT_MS = '5000',
  DB_IDLE_TX_TIMEOUT_MS = '5000',
  // Redis
  REDIS_URL = 'redis://redis:6379',
  // CORS
  CORS_ALLOWLIST = '', // "https://app.example.com,https://www.example.com"
} = process.env;

const isProd = NODE_ENV === 'production';

// ──────────────────────────────────────────────────────────────────────────────
/** CORS allowlist → массив доменов */
function parseAllowlist(src: string): string[] {
  return src
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
const corsAllow = parseAllowlist(CORS_ALLOWLIST);

// ──────────────────────────────────────────────────────────────────────────────
// Инициализация внешних клиентов
// ──────────────────────────────────────────────────────────────────────────────
const pgPool = new Pool({
  connectionString: DB_URL,
  statement_timeout: Number(DB_STATEMENT_TIMEOUT_MS) || 5000,
  idle_in_transaction_session_timeout: Number(DB_IDLE_TX_TIMEOUT_MS) || 5000,
  max: 20,
});

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableAutoPipelining: true,
  lazyConnect: false,
});

// ──────────────────────────────────────────────────────────────────────────────
// Fastify
// ──────────────────────────────────────────────────────────────────────────────
const app: FastifyInstance = Fastify({
  logger: {
    level: isProd ? 'info' : 'debug',
    transport: isProd
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
  },
  bodyLimit: 10 * 1024 * 1024, // 10MB; большие аплоады идут напрямую в S3
  requestIdHeader: 'x-request-id',
  genReqId: () => cryptoRandomId(),
});

// Core plugins & hardening
await registerValidation(app);
await registerSecurity(app);
await registerRateLimit(app);
await registerOpenAPI(app);
await app.register(metricsPlugin, { pool: pgPool, redis });

function nonce() {
  return Buffer.from(cryptoRandomId()).toString('base64');
}
function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ──────────────────────────────────────────────────────────────────────────────
// Плагины безопасности
// ──────────────────────────────────────────────────────────────────────────────
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "font-src": ["'self'", "https:", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "object-src": ["'none'"],
      "script-src": [
        "'self'",
        (_req, _res) => `'nonce-${nonce()}'`,
      ],
      "style-src": ["'self'", "'unsafe-inline'", "https:"],
      "connect-src": ["'self'", "https:", "wss:"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer-when-downgrade' },
  strictTransportSecurity: isProd
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
      }
    : false,
});

// CORS handled by security plugin

// Rate limit handled by ratelimit plugin

// Вебсокеты
await app.register(websocket);

// OpenAPI handled by registerOpenAPI

// ──────────────────────────────────────────────────────────────────────────────
// Health & Ready
// ──────────────────────────────────────────────────────────────────────────────
// healthz/readyz are provided by metrics plugin

// ──────────────────────────────────────────────────────────────────────────────
// WS endpoint (скелет событий мессенджера)
// ──────────────────────────────────────────────────────────────────────────────
app.get('/v1/ws', { websocket: true }, (conn, req) => {
  const log = req.log.child({ ws: true });
  log.info('WS connected');

  conn.socket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      switch (msg.type) {
        case 'ping':
          conn.socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
        default:
          conn.socket.send(JSON.stringify({ type: 'error', error: 'unknown_type' }));
      }
    } catch (e) {
      log.warn({ err: e }, 'WS parse error');
      conn.socket.send(JSON.stringify({ type: 'error', error: 'bad_json' }));
    }
  });

  conn.socket.on('close', () => log.info('WS closed'));
});

// ──────────────────────────────────────────────────────────────────────────────
// Роуты v1 под префиксом /v1
// ──────────────────────────────────────────────────────────────────────────────
await app.register(v1Routes, { prefix: '/v1' });

// ──────────────────────────────────────────────────────────────────────────────
// Глобальный error handler
// ──────────────────────────────────────────────────────────────────────────────
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'unhandled error');
  const status = (err as any).statusCode || 500;
  reply.code(status).send({ error: 'internal_error', status });
});

// ──────────────────────────────────────────────────────────────────────────────
// Старт / останов
// ──────────────────────────────────────────────────────────────────────────────
const port = Number(PORT) || 8080;

async function start() {
  try {
    await Promise.all([pgPool.query('SELECT 1'), redis.ping()]);
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`API listening on :${port} (${NODE_ENV})`);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'graceful shutdown start');
  try { await app.close(); } catch (e) { app.log.error({ err: e }, 'fastify close failed'); }
  try { await pgPool.end(); } catch (e) { app.log.error({ err: e }, 'pg pool close failed'); }
  try { await redis.quit(); } catch (e) { app.log.error({ err: e }, 'redis quit failed'); try { await redis.disconnect(); } catch {} }
  app.log.info('shutdown complete');
  process.exit(0);
}

['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => void shutdown(sig));
});

void start();
