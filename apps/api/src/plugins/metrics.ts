/**
 * Fastify plugin: metrics + healthz/readyz + HTTP latency
 *
 * Подключение:
 *  import metricsPlugin from './plugins/metrics';
 *  await app.register(metricsPlugin, { pool, redis });
 *
 * Эндпойнты:
 *  GET /healthz — быстрая проверка: процесс жив
 *  GET /readyz  — глубокая проверка: Postgres/Redis
 *  GET /metrics — Prometheus метрики
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import {
  buildMetricsHandler,
  onRequestStart,
  onResponseEnd,
  makeHistogram,
  timerStart,
  pg_query_seconds,
  redis_cmd_seconds,
} from '@observability';

type Opts = {
  pool: Pool;
  redis: Redis;
};

const dbReadyHistogram = makeHistogram(
  'readyz_db_check_seconds',
  'readiness: db ping duration',
  []
);
const redisReadyHistogram = makeHistogram(
  'readyz_redis_check_seconds',
  'readiness: redis ping duration',
  []
);

const plugin: FastifyPluginAsync<Opts> = async (app: FastifyInstance, opts: Opts) => {
  const { pool, redis } = opts;

  // ── HTTP latency ────────────────────────────────────────────────────────────
  app.addHook('onRequest', onRequestStart);
  app.addHook('onResponse', onResponseEnd);

  // ── healthz ────────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── readyz (DB + Redis) ────────────────────────────────────────────────────
  app.get('/readyz', async (_req, reply) => {
    let dbOk = false; let redisOk = false; let dbErr: string | null = null; let redisErr: string | null = null;

    // DB ping
    const t1 = timerStart();
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch (e: any) {
      dbErr = String(e?.message || e);
    } finally {
      t1.observe(dbReadyHistogram);
    }

    // Redis ping
    const t2 = timerStart();
    try {
      const pong = await redis.ping();
      redisOk = pong === 'PONG';
    } catch (e: any) {
      redisErr = String(e?.message || e);
    } finally {
      t2.observe(redisReadyHistogram);
    }

    const ok = dbOk && redisOk;
    return reply.code(ok ? 200 : 503).send({
      ok,
      db: dbOk ? 'ok' : `error: ${dbErr}`,
      redis: redisOk ? 'ok' : `error: ${redisErr}`,
    });
  });

  // ── metrics ────────────────────────────────────────────────────────────────
  app.get('/metrics', { logLevel: 'warn' }, buildMetricsHandler);

  // ── optional: обёртки-хелперы для замера DB/Redis (если захотите использовать) ─
  app.decorate('metrics', {
    async timedDb<T>(op: string, fn: () => Promise<T>): Promise<T> {
      const t = timerStart();
      try { return await fn(); }
      finally { t.observe(pg_query_seconds, { op }); }
    },
    async timedRedis<T>(op: string, fn: () => Promise<T>): Promise<T> {
      const t = timerStart();
      try { return await fn(); }
      finally { t.observe(redis_cmd_seconds, { op }); }
    },
  });
};

export default fp(plugin, {
  fastify: '4.x',
  name: 'metrics-plugin',
});
