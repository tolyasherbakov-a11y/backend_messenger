-- ─────────────────────────────────────────────────────────────────────────────
-- 001_init.sql
-- Базовые расширения, helper-функции времени и updated_at, таблица users,
-- частичные уникальные индексы, необходимые для мягких удалений.
-- Требования: PostgreSQL 14+ (рекомендуется 16+).
-- ─────────────────────────────────────────────────────────────────────────────

-- Безопасные настройки транзакции миграции
BEGIN;

-- Расширения
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- для gen_random_uuid()

-- ── UTC-время как единый источник истины
CREATE OR REPLACE FUNCTION now_utc() RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT timezone('utc', now());
$$;

-- ── Универсальный триггер обновления updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now_utc();
  RETURN NEW;
END;
$$;

-- ── Пользователи
-- Мягкое удаление (deleted_at) + частичные уникальные индексы на email/nickname только для "живых" записей
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL,
  password_hash  text   NOT NULL CHECK (length(password_hash) >= 6),
  display_name   text   NOT NULL CHECK (btrim(display_name) <> ''),
  nickname       citext NULL,
  roles          text[] NOT NULL DEFAULT '{}'::text[],
  privacy        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  bio            text   NULL,
  created_at     timestamptz NOT NULL DEFAULT now_utc(),
  updated_at     timestamptz NOT NULL DEFAULT now_utc(),
  deleted_at     timestamptz NULL
);

COMMENT ON TABLE  users IS 'Учетные записи пользователей (мягкое удаление через deleted_at).';
COMMENT ON COLUMN users.email        IS 'CITEXT; частично уникален среди не удаленных записей.';
COMMENT ON COLUMN users.nickname     IS 'Публичный ник; частично уникален среди не удаленных записей.';
COMMENT ON COLUMN users.roles        IS 'Список ролей/привилегий (текстовые ярлыки).';
COMMENT ON COLUMN users.privacy      IS 'Настройки приватности в JSONB.';
COMMENT ON COLUMN users.deleted_at   IS 'Мягкое удаление; при значении НЕ NULL запись считается удаленной.';

-- Индексы под keyset-пагинацию и поиск
CREATE INDEX IF NOT EXISTS idx_users_created_desc ON users (created_at DESC, id DESC);

-- Частичные уникальные индексы: допускаем повторное использование email/nickname после soft-delete
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_users_email_alive'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_users_email_alive ON users (email) WHERE deleted_at IS NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_users_nickname_alive'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_users_nickname_alive ON users (nickname) WHERE deleted_at IS NULL';
  END IF;
END$$;

-- Триггеры обновления updated_at
DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
