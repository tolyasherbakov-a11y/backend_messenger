-- ─────────────────────────────────────────────────────────────────────────────
-- 006_receipts.sql
-- Квитанции доставок/прочтений сообщений: delivered/read.
-- PK (message_id, user_id), частичные индексы для быстрых выборок "непрочитанных".
-- Требования: 001 (users), 004 (conversations), 005 (messages).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id     uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,

  delivered_at   timestamptz NULL,
  read_at        timestamptz NULL,

  updated_at     timestamptz NOT NULL DEFAULT now_utc(),

  PRIMARY KEY (message_id, user_id),

  -- Нельзя прочитать раньше, чем доставлено
  CHECK (read_at IS NULL OR delivered_at IS NULL OR read_at >= delivered_at)
);

COMMENT ON TABLE  message_receipts IS 'Квитанции доставок и прочтений сообщений для участников бесед.';
COMMENT ON COLUMN message_receipts.delivered_at IS 'Момент, когда клиент подтвердил доставку сообщения.';
COMMENT ON COLUMN message_receipts.read_at      IS 'Момент, когда сообщение было отмечено как прочитанное.';

-- Индексы для быстрых запросов «что ещё не прочитано/не доставлено»
CREATE INDEX IF NOT EXISTS idx_receipts_user_unread
  ON message_receipts (user_id, message_id)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_user_undelivered
  ON message_receipts (user_id, message_id)
  WHERE delivered_at IS NULL;

-- Для массовых апдейтов «прочитал всё до метки» пригодится индекс по (user_id, message_id)
CREATE INDEX IF NOT EXISTS idx_receipts_user_message
  ON message_receipts (user_id, message_id);

-- Обновление updated_at
DROP TRIGGER IF EXISTS trg_message_receipts_set_updated_at ON message_receipts;
CREATE TRIGGER trg_message_receipts_set_updated_at
BEFORE UPDATE ON message_receipts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
