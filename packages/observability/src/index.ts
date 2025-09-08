/**
 * Observability package (Prometheus + helpers)
 *
 * Возможности:
 *  - Единый Registry с дефолтными метриками процесса/NodeJS
 *  - Фабрики Counter/Gauge/Histogram/Summary с автолейблами приложения
 *  - HTTP-экспортер метрик (ф-ция buildMetricsHandler)
 *  - Хелперы таймингов для Postgres/Redis/внешних вызовов
 *
 * ENV (опционально):
 *  APP_NAME      — имя приложения (по умолчанию "app")
 *  SERVICE_NAME  — конкретный сервис (напр. "api", "video-transcoder")
 *  METRICS_PREFIX — префикс метрик (по умолчанию "app")
 */

import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Counter, Gauge, Histogram, Summary, Registry, collectDefaultMetrics } from 'prom-client';

const {
  APP_NAME = 'app',
  SERVICE_NAME = '',
  METRICS_PREFIX = 'app',
} = process.env;

// ──────────────────────────────────────────────────────────────────────────────
// Registry + default metrics
// ──────────────────────────────────────────────────────────────────────────────
export const registry = new Registry();

registry.setDefaultLabels({
  app: APP_NAME,
  service: SERVICE_NAME || 'unknown',
});

collectDefaultMetrics({
  prefix: `${METRICS_PREFIX}_`,
  register: registry,
  gcDurationBuckets: [0.001, 0.01, 0.1, 0.5, 1, 2],
});

// ──────────────────────────────────────────────────────────────────────────────
// Metric factories (с автопрефиксом и регистрацией в общем реестре)
// ──────────────────────────────────────────────────────────────────────────────
type Labels = Record<string, string | number>;

export function makeCounter(name: string, help: string, labelNames: string[] = []) {
  return new Counter({
    name: `${METRICS_PREFIX}_${name}`,
    help,
    labelNames,
    registers: [registry],
  });
}

export function makeGauge(name: string, help: string, labelNames: string[] = []) {
  return new Gauge({
    name: `${METRICS_PREFIX}_${name}`,
    help,
    labelNames,
    registers: [registry],
  });
}

export function makeHistogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets: number[] = [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2,4,8] // секунды
) {
  return new Histogram({
    name: `${METRICS_PREFIX}_${name}`,
    help,
    labelNames,
    buckets,
    registers: [registry],
  });
}

export function makeSummary(name: string, help: string, labelNames: string[] = []) {
  return new Summary({
    name: `${METRICS_PREFIX}_${name}`,
    help,
    labelNames,
    percentiles: [0.5, 0.9, 0.99],
    registers: [registry],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP exporter
// ──────────────────────────────────────────────────────────────────────────────
export async function buildMetricsHandler(_req: FastifyRequest, reply: FastifyReply) {
  reply
    .header('Content-Type', registry.contentType)
    .send(await registry.metrics());
}

// ──────────────────────────────────────────────────────────────────────────────
// Ready-made HTTP metrics (Fastify middleware-helpers)
// ──────────────────────────────────────────────────────────────────────────────
export const httpReqDuration = makeHistogram(
  'http_request_duration_seconds',
  'HTTP request duration, seconds',
  ['method', 'route', 'status']
);

export function onRequestStart(req: FastifyRequest) {
  (req as any).__metricsStart = process.hrtime.bigint();
}

export function onResponseEnd(req: FastifyRequest, reply: FastifyReply) {
  const started = (req as any).__metricsStart as bigint | undefined;
  if (!started) return;
  const ns = Number(process.hrtime.bigint() - started); // наносекунды
  const sec = ns / 1e9;
  const method = (req.raw.method || 'GET').toUpperCase();
  const route = (reply.contextConfig?.url || (req.routerPath as any) || req.url || 'unknown').split('?')[0];
  const status = reply.statusCode || 0;
  httpReqDuration.labels(method, route, String(status)).observe(sec);
}

// ──────────────────────────────────────────────────────────────────────────────
// Timers helpers (PG/Redis/External)
// Usage:
//   const t = timerStart(); ... finally t.observe(pgQueryHistogram, { op: 'select_users' });
// ──────────────────────────────────────────────────────────────────────────────
export function timerStart(): { end: () => number; observe: (h: Histogram<string>, labels?: Labels) => void } {
  const start = process.hrtime.bigint();
  return {
    end() {
      const ns = Number(process.hrtime.bigint() - start);
      return ns / 1e9; // seconds
    },
    observe(h, labels = {}) {
      const sec = this.end();
      if (labels && Object.keys(labels).length) (h.labels as any)(labels).observe(sec);
      else h.observe(sec);
    },
  };
}

export const pg_query_seconds = makeHistogram(
  'pg_query_duration_seconds',
  'Postgres query duration, seconds',
  ['op'] // опциональная метка операции
);

export const redis_cmd_seconds = makeHistogram(
  'redis_command_duration_seconds',
  'Redis command duration, seconds',
  ['op']
);

export const external_call_seconds = makeHistogram(
  'external_call_duration_seconds',
  'External HTTP/calls duration, seconds',
  ['target']
);

// ──────────────────────────────────────────────────────────────────────────────
// Lightweight metrics server (для воркеров) — по желанию можно использовать
// ──────────────────────────────────────────────────────────────────────────────
export async function startWorkerMetricsServer(opts?: { port?: number; host?: string }) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/metrics', buildMetricsHandler);
  const port = opts?.port ?? 9090;
  const host = opts?.host ?? '0.0.0.0';
  await app.listen({ port, host });
  // Возвращаем функцию для закрытия
  return async () => { try { await app.close(); } catch {} };
}
