// packages/redis/src/index.ts
import IORedis, { Redis, Result } from 'ioredis';
import { env } from '@config/index';

export let redis: Redis | null = null;

export async function initRedis(): Promise<void> {
  if (redis) return;
  const client = new IORedis(env.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });
  await client.connect();
  redis = client;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    try { await redis.quit(); } catch {}
    redis = null;
  }
}

export function makeConsumerName(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${process.pid}-${rnd}`;
}

export async function ensureGroup(stream: string, group: string): Promise<void> {
  if (!redis) await initRedis();
  try {
    await redis!.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (e: any) {
    const m = String(e?.message || e);
    if (!m.includes('BUSYGROUP')) throw e;
  }
}

type ReadResp = {
  entries: Array<{ id: string; data: Record<string, string> }>;
};

export async function readGroup(opts: { stream: string; group: string; consumer: string; count?: number; blockMs?: number }): Promise<ReadResp> {
  if (!redis) await initRedis();
  const count = Math.max(1, Math.min(opts.count ?? 10, 512));
  const block = Math.max(0, Math.min(opts.blockMs ?? 2000, 60000));
  const res = await redis!.xreadgroup('GROUP', opts.group, opts.consumer, 'COUNT', count, 'BLOCK', block, 'STREAMS', opts.stream, '>');
  const entries: ReadResp['entries'] = [];
  if (Array.isArray(res)) {
    for (const [streamName, items] of res as any[]) {
      if (!Array.isArray(items)) continue;
      for (const [id, fields] of items) {
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1];
        entries.push({ id, data });
      }
    }
  }
  return { entries };
}

export async function xack(stream: string, group: string, ids: string[]): Promise<Result<number, string>> {
  if (!redis) await initRedis();
  return redis!.xack(stream, group, ...ids);
}

export async function xaddJson(stream: string, payload: any): Promise<string> {
  if (!redis) await initRedis();
  // Сохраняем JSON в поле "json"
  return redis!.xadd(stream, '*', 'json', JSON.stringify(payload));
}

export function parseEntryJson<T = any>(entry: { data: Record<string, string> }): T | null {
  try {
    const raw = entry.data.json || '{}';
    return JSON.parse(raw) as T;
  } catch { return null; }
}
