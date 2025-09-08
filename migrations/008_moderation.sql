-- ─────────────────────────────────────────────────────────────────────────────
-- 008_moderation.sql
-- Жалобы, статусы модерации, аудит действий модераторов, блокировки.
-- Требования: 001 (users), 003 (media_files), 004–007.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Перечисления статусов жалоб и действий модерации
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
    CREATE TYPE report_status AS ENUM ('open','reviewing','resolved','rejected','blocked');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_action_kind') THEN
    CREATE TYPE moderation_action_kind AS ENUM (
      'hide_post','unhide_post',
      'block_channel','unblock_channel',
      'ban_user','unban_user',
      'remove_message','restore_message',
      'note'
    );
  END IF;
END$$;

-- Жалобы пользователей на контент/пользователей
CREATE TABLE IF NOT EXISTS reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  target_type  text NOT NULL CHECK (target_type IN ('post','channel','message','user')),
  target_id    uuid NOT NULL,

  reason       text NOT NULL CHECK (btrim(reason) <> ''),
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,

  status       report_status NOT NULL DEFAULT 'open',
  moderator_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  resolution   text NULL,

  created_at   timestamptz NOT NULL DEFAULT now_utc(),
  updated_at   timestamptz NOT NULL DEFAULT now_utc(),
  resolved_at  timestamptz NULL
);

COMMENT ON TABLE reports IS 'Жалобы пользователей. Статусы и резолюции фиксируются для аудита.';

CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON reports (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reports_target
  ON reports (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports (reporter_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_reports_set_updated_at ON reports;
CREATE TRIGGER trg_reports_set_updated_at
BEFORE UPDATE ON reports
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Аудит действий модераторов (вне зависимости от наличия "reports")
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- модератор/админ
  action       moderation_action_kind NOT NULL,

  target_type  text NOT NULL CHECK (target_type IN ('post','channel','message','user')),
  target_id    uuid NOT NULL,

  report_id    uuid NULL REFERENCES reports(id) ON DELETE SET NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb, -- любые параметры действия

  created_at   timestamptz NOT NULL DEFAULT now_utc()
);

COMMENT ON TABLE moderation_actions IS 'Журнал действий модераторов, привязка к report при наличии.';

CREATE INDEX IF NOT EXISTS idx_moderation_actions_target
  ON moderation_actions (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_actor
  ON moderation_actions (actor_id, created_at DESC, id DESC);

-- Таблицы блокировок (мягкие; снятие блокировки фиксируется отдельным действием)
CREATE TABLE IF NOT EXISTS user_bans (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  banned_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now_utc(),
  expires_at  timestamptz NULL
);

COMMENT ON TABLE user_bans IS 'Блокировки пользователей (глобальные).';

CREATE INDEX IF NOT EXISTS idx_user_bans_expires
  ON user_bans (expires_at);

CREATE TABLE IF NOT EXISTS channel_blocks (
  channel_id  uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  blocked_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now_utc(),
  expires_at  timestamptz NULL
);

COMMENT ON TABLE channel_blocks IS 'Блокировки каналов.';

CREATE INDEX IF NOT EXISTS idx_channel_blocks_expires
  ON channel_blocks (expires_at);

COMMIT;
