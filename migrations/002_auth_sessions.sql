-- ─────────────────────────────────────────────────────────────────────────────
-- 002_auth_sessions.sql
-- Хранение refresh-сессий: храним хэш токена, ротация через replaced_by,
-- возможность отзыва и аудита. TTL управляется воркером GC.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Владелец сессии
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Хэш refresh-токена (никогда не хранить в открытом виде!)
  refresh_hash   char(64) NOT NULL CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),

  -- Метаданные устройства/клиента
  user_agent     text NULL,
  ip_address     inet NULL,

  -- Статус жизненного цикла
  created_at     timestamptz NOT NULL DEFAULT now_utc(),
  revoked_at     timestamptz NULL,
  replaced_by    uuid NULL REFERENCES auth_sessions(id) ON DELETE SET NULL,

  -- Дополнительно: срок действия (удаляется GC после истечения)
  expires_at     timestamptz NOT NULL DEFAULT (now_utc() + interval '30 days')
);

COMMENT ON TABLE  auth_sessions IS 'Refresh-сессии (храним только хэш токена).';
COMMENT ON COLUMN auth_sessions.refresh_hash IS 'SHA-256 хэш refresh токена. Оригинал на сервере не хранится.';
COMMENT ON COLUMN auth_sessions.replaced_by  IS 'При ротации указывает на новую сессию.';

-- Индексы
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_created
  ON auth_sessions (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions (expires_at);

-- Один активный refresh_hash на пользователя + хэш
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_auth_sessions_user_hash'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_auth_sessions_user_hash
             ON auth_sessions (user_id, refresh_hash)
             WHERE revoked_at IS NULL';
  END IF;
END$$;

-- Триггер обновления updated_at в этой таблице не нужен:
-- записи либо вставляются, либо помечаются revoked/rotated.
-- Но можно добавить set_updated_at для унификации.
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now_utc();

DROP TRIGGER IF EXISTS trg_auth_sessions_set_updated_at ON auth_sessions;
CREATE TRIGGER trg_auth_sessions_set_updated_at
BEFORE UPDATE ON auth_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
