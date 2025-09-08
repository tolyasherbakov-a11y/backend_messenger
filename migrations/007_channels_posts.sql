-- ─────────────────────────────────────────────────────────────────────────────
-- 007_channels_posts.sql
-- Каналы, посты, связь с медиа, реакции пользователей.
-- Включает перечисления видимости канала и статусов поста, индексы под keyset.
-- Требования: 001 (users), 003 (media_files).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Перечисления
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_visibility') THEN
    CREATE TYPE channel_visibility AS ENUM ('public','unlisted','private');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_status') THEN
    CREATE TYPE post_status AS ENUM ('draft','published','hidden','deleted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reaction_kind') THEN
    -- базовый набор; можно расширять на уровне приложения
    CREATE TYPE reaction_kind AS ENUM ('like','love','laugh','wow','sad','angry');
  END IF;
END$$;

-- ── Каналы
CREATE TABLE IF NOT EXISTS channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle        citext NOT NULL, -- публичный @handle
  title         text   NOT NULL CHECK (btrim(title) <> ''),
  description   text   NULL,
  visibility    channel_visibility NOT NULL DEFAULT 'public',
  created_at    timestamptz NOT NULL DEFAULT now_utc(),
  updated_at    timestamptz NOT NULL DEFAULT now_utc(),
  deleted_at    timestamptz NULL
);

COMMENT ON TABLE  channels IS 'Публичные/приватные каналы с постами (видеохостинг/лента).';
COMMENT ON COLUMN channels.handle IS 'Уникальный публичный идентификатор канала (@handle).';

-- Уникальность handle среди «живых» записей
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_channels_handle_alive'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_channels_handle_alive ON channels (handle) WHERE deleted_at IS NULL';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_channels_owner_created
  ON channels (owner_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_channels_set_updated_at ON channels;
CREATE TRIGGER trg_channels_set_updated_at
BEFORE UPDATE ON channels
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Посты в каналах
CREATE TABLE IF NOT EXISTS posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users(id)    ON DELETE SET NULL,
  title         text   NULL,  -- может быть пустым для «видео без заголовка»
  body          text   NULL,
  status        post_status NOT NULL DEFAULT 'draft',
  published_at  timestamptz NULL,     -- заполняется при публикации
  created_at    timestamptz NOT NULL DEFAULT now_utc(),
  updated_at    timestamptz NOT NULL DEFAULT now_utc(),
  deleted_at    timestamptz NULL,

  -- быстрые проверки целостности
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

COMMENT ON TABLE posts IS 'Посты каналов (видео/картинки/текст); статусная модель публикации.';

-- Индексы под ленту/листинги канала
CREATE INDEX IF NOT EXISTS idx_posts_channel_created_desc
  ON posts (channel_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_posts_channel_published_desc
  ON posts (channel_id, published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_created_desc
  ON posts (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_posts_published_desc
  ON posts (published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_posts_set_updated_at ON posts;
CREATE TRIGGER trg_posts_set_updated_at
BEFORE UPDATE ON posts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Привязка медиа к посту (многие-к-одному с упорядочением)
CREATE TABLE IF NOT EXISTS post_media (
  post_id     uuid NOT NULL REFERENCES posts(id)        ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES media_files(id)  ON DELETE RESTRICT,
  ord         integer NOT NULL DEFAULT 0 CHECK (ord >= 0),
  created_at  timestamptz NOT NULL DEFAULT now_utc(),
  PRIMARY KEY (post_id, media_id)
);

COMMENT ON TABLE post_media IS 'Набор медиа в посте (видео/изображения) с порядком отображения.';

-- Быстрый доступ ко всем медиа поста по порядку
CREATE INDEX IF NOT EXISTS idx_post_media_ord
  ON post_media (post_id, ord, media_id);

-- ── Реакции пользователей на посты
CREATE TABLE IF NOT EXISTS reactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text NOT NULL CHECK (target_type IN ('post')), -- расширяемо в будущем
  target_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         reaction_kind NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now_utc()
);

COMMENT ON TABLE reactions IS 'Реакции пользователей на посты (like/love/...).';

-- Один пользователь — один вид реакции на конкретную сущность
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_reactions_unique'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_reactions_unique
             ON reactions (target_type, target_id, user_id, kind)';
  END IF;
END$$;

-- Для подсчётов/выборок
CREATE INDEX IF NOT EXISTS idx_reactions_target_kind
  ON reactions (target_type, target_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reactions_user_created
  ON reactions (user_id, created_at DESC, id DESC);

COMMIT;
