// packages/db/src/index.ts
import postgres, { Sql } from 'postgres';
import { env } from '@config/index';

let _sql: Sql | null = null;

export function getSql(): Sql {
  if (_sql) return _sql;
  _sql = postgres(env.db.url, {
    max: env.db.max,
    idle_timeout: env.db.idleTimeoutMs,
    prepare: true,
    onnotice: () => {},
    ssl: 'prefer'
  });
  return _sql!;
}

export const sql = getSql();

/** Обёртка для транзакций */
export async function transaction<T>(fn: (trx: Sql) => Promise<T>): Promise<T> {
  const s = getSql();
  return s.begin(fn);
}

/** Закрыть соединения при завершении процесса */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}
