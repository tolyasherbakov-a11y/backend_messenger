-- ─────────────────────────────────────────────────────────────────────────────
-- 004_conversations.sql
-- Диалоги/группы и участники: enums, таблицы, индексы, триггеры.
-- Требования: 001_init.sql (users), 002/003 применены ранее.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Перечисления
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_type') THEN
    CREATE TYPE conversation_type AS ENUM ('private','group');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
    CREATE TYPE member_role AS ENUM ('owner','admin','member');
  END IF;
END$$;

-- ── Таблица разговоров
CREATE TABLE IF NOT EXISTS conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             conversation_type NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title            text NULL,                    -- для групп, у private обычно NULL
  topic            text NULL,
  last_message_at  timestamptz NULL,             -- для сортировки по активности
  created_at       timestamptz NOT NULL DEFAULT now_utc(),
  updated_at       timestamptz NOT NULL DEFAULT now_utc(),
  deleted_at       timestamptz NULL
);

COMMENT ON TABLE  conversations IS 'Диалоги (private) и групповые чаты (group).';
COMMENT ON COLUMN conversations.last_message_at IS 'Обновляется при новом сообщении; ускоряет выборки по активности.';

-- Индексы: список бесед пользователя (через members), сортировка по активности/созданию
CREATE INDEX IF NOT EXISTS idx_conversations_created_desc ON conversations (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg_desc ON conversations (COALESCE(last_message_at, created_at) DESC, id DESC);

-- Триггер updated_at
DROP TRIGGER IF EXISTS trg_conversations_set_updated_at ON conversations;
CREATE TRIGGER trg_conversations_set_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Участники бесед
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             member_role NOT NULL DEFAULT 'member',
  notifications    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- настройки уведомлений
  joined_at        timestamptz NOT NULL DEFAULT now_utc(),
  left_at          timestamptz NULL,
  updated_at       timestamptz NOT NULL DEFAULT now_utc(),
  PRIMARY KEY (conversation_id, user_id),
  CHECK (left_at IS NULL OR left_at >= joined_at)
);

COMMENT ON TABLE conversation_members IS 'Члены диалога/группы; soft-leave через left_at.';
COMMENT ON COLUMN conversation_members.notifications IS 'Пользовательские настройки уведомлений для беседы.';

-- Активные участники (left_at IS NULL) — частичный индекс ускоряет выборки
CREATE INDEX IF NOT EXISTS idx_members_conversation_active
  ON conversation_members (conversation_id, user_id)
  WHERE left_at IS NULL;

-- Индекс для получения всех бесед пользователя (через members)
CREATE INDEX IF NOT EXISTS idx_members_user_joined_desc
  ON conversation_members (user_id, joined_at DESC, conversation_id);

-- Триггер updated_at
DROP TRIGGER IF EXISTS trg_conversation_members_set_updated_at ON conversation_members;
CREATE TRIGGER trg_conversation_members_set_updated_at
BEFORE UPDATE ON conversation_members
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Опционально: гарантировать наличие хотя бы одного owner в группе
-- (в БД сложно обеспечить всегда; обеспечивается приложением/транзакциями).
-- Здесь ограничимся проверкой ролей на уровне приложения.

COMMIT;
