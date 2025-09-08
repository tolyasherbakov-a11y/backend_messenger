-- ─────────────────────────────────────────────────────────────────────────────
-- 005_messages.sql
-- Сообщения: enums, таблица сообщений, ссылки на media_files (опционально),
-- индексы под keyset-пагинацию, триггеры. Квитанции доставок в 006.
-- Требования: 001 (users), 003 (media_files) и 004 (conversations).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Перечисления
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_kind') THEN
    CREATE TYPE message_kind AS ENUM ('text','media','system');
  END IF;
END$$;

-- ── Сообщения
CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id        uuid NULL REFERENCES users(id) ON DELETE SET NULL, -- у system msg автора может не быть
  kind             message_kind NOT NULL DEFAULT 'text',

  text             text NULL,                   -- для kind='text'/'system'
  media_id         uuid NULL REFERENCES media_files(id) ON DELETE SET NULL, -- для kind='media'
  reply_to_id      uuid NULL REFERENCES messages(id) ON DELETE SET NULL,    -- ответ на сообщение

  -- метаданные
  created_at       timestamptz NOT NULL DEFAULT now_utc(),
  updated_at       timestamptz NOT NULL DEFAULT now_utc(),
  edited_at        timestamptz NULL,
  deleted_at       timestamptz NULL,

  -- быстрые проверки
  CHECK (
    (kind = 'text'   AND text IS NOT NULL)
 OR (kind = 'media'  AND media_id IS NOT NULL)
 OR (kind = 'system' AND text IS NOT NULL)
  )
);

COMMENT ON TABLE  messages IS 'Сообщения бесед: текстовые, медийные, системные.';
COMMENT ON COLUMN messages.reply_to_id IS 'Ссылка на исходное сообщение (thread/light reply).';

-- Индексы под keyset-пагинацию в рамках беседы
CREATE INDEX IF NOT EXISTS idx_messages_conv_created_desc
  ON messages (conversation_id, created_at DESC, id DESC);

-- Для профилей пользователя: быстрые выборки его сообщений (необязательно)
CREATE INDEX IF NOT EXISTS idx_messages_author_created_desc
  ON messages (author_id, created_at DESC, id DESC);

-- Ускорение навигации по "ответам"
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages (reply_to_id);

-- Триггер обновления updated_at
DROP TRIGGER IF EXISTS trg_messages_set_updated_at ON messages;
CREATE TRIGGER trg_messages_set_updated_at
BEFORE UPDATE ON messages
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Примечание:
-- 1) Требование "reply_to в той же беседе" реализуется на уровне приложения
--    (в CHECK нельзя делать подзапрос). Вставки/апдейты должны валидировать это.
-- 2) Удаление беседы каскадом удалит все её сообщения (ON DELETE CASCADE).
-- 3) Удаление автора не ломает историю (author_id становится NULL).
-- 4) Мягкое удаление сообщений через deleted_at; индекс под это обычно не нужен,
--    но фильтрацию выполняем в приложении.

COMMIT;
