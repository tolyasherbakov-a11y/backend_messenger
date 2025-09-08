-- ─────────────────────────────────────────────────────────────────────────────
-- 003_media.sql
-- Медиа-подсистема: таблицы файлов, вариантов, сессий загрузки; статусы AV,
-- индексы под дедупликацию и keyset-пагинацию; триггеры updated_at.
-- Предполагает наличие таблицы users из 001_init.sql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Перечисления статусов
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_antivirus_status') THEN
    CREATE TYPE media_antivirus_status AS ENUM ('pending','clean','infected','error');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'upload_status') THEN
    CREATE TYPE upload_status AS ENUM ('initiated','completed','aborted','expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_profile') THEN
    -- "orig" хранится в media_files; варианты — здесь
    CREATE TYPE media_profile AS ENUM ('360p','480p','720p','1080p');
  END IF;
END$$;

-- ── Медиа-файлы (оригиналы)
CREATE TABLE IF NOT EXISTS media_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  sha256              char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key         text     NOT NULL,         -- ключ в S3/совместимом хранилище
  mime                text     NOT NULL,         -- исходный MIME
  size                bigint   NOT NULL CHECK (size > 0),
  width               integer  NULL CHECK (width  IS NULL OR width  > 0),
  height              integer  NULL CHECK (height IS NULL OR height > 0),
  duration_sec        numeric(10,3) NULL CHECK (duration_sec IS NULL OR duration_sec >= 0),
  phash64             bigint   NULL,             -- 64-бит pHash (опционально)
  antivirus_status    media_antivirus_status NOT NULL DEFAULT 'pending',
  antivirus_signature text     NULL,
  scanned_at          timestamptz NULL,
  quarantined         boolean  NOT NULL DEFAULT false,
  ref_count           integer  NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  created_at          timestamptz NOT NULL DEFAULT now_utc(),
  updated_at          timestamptz NOT NULL DEFAULT now_utc()
);

COMMENT ON TABLE  media_files IS 'Оригинальные загруженные медиа-файлы с дедупликацией по sha256.';
COMMENT ON COLUMN media_files.storage_key      IS 'Путь/ключ в S3 (private bucket).';
COMMENT ON COLUMN media_files.antivirus_status IS 'Статус результата антивирусной проверки.';
COMMENT ON COLUMN media_files.quarantined      IS 'Флаг карантина (доступ запрещен до очистки).';
COMMENT ON COLUMN media_files.ref_count        IS 'Ссылочная счетчик на использование файла постами/сообщениями.';

-- Дедупликация и выборки
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_files_sha256 ON media_files (sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_files_storage_key ON media_files (storage_key);
CREATE INDEX        IF NOT EXISTS idx_media_files_owner_created ON media_files (owner_id, created_at DESC, id DESC);
CREATE INDEX        IF NOT EXISTS idx_media_files_created_desc  ON media_files (created_at DESC, id DESC);
-- Частичные индексы по статусам AV
CREATE INDEX IF NOT EXISTS idx_media_files_av_pending  ON media_files (created_at) WHERE antivirus_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_media_files_quarantine  ON media_files (created_at) WHERE quarantined = true;

-- Триггер updated_at
DROP TRIGGER IF EXISTS trg_media_files_set_updated_at ON media_files;
CREATE TRIGGER trg_media_files_set_updated_at
BEFORE UPDATE ON media_files
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Варианты медиа (транскодированные профили)
CREATE TABLE IF NOT EXISTS media_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id      uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  profile       media_profile NOT NULL,
  storage_key   text NOT NULL,            -- ключ S3 для варианта
  size          bigint NOT NULL CHECK (size >= 0),
  width         integer NOT NULL CHECK (width  > 0),
  height        integer NOT NULL CHECK (height > 0),
  bitrate_kbps  integer NULL CHECK (bitrate_kbps IS NULL OR bitrate_kbps >= 0),
  ready_at      timestamptz NULL,         -- когда вариант стал доступен
  created_at    timestamptz NOT NULL DEFAULT now_utc(),
  updated_at    timestamptz NOT NULL DEFAULT now_utc(),
  UNIQUE (media_id, profile)
);

COMMENT ON TABLE media_variants IS 'Транскодированные/ресайз варианты оригинала по профилям.';
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_variants_storage_key ON media_variants (storage_key);
CREATE INDEX        IF NOT EXISTS idx_media_variants_media_created ON media_variants (media_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_media_variants_set_updated_at ON media_variants;
CREATE TRIGGER trg_media_variants_set_updated_at
BEFORE UPDATE ON media_variants
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Сессии загрузки (multipart / presign)
CREATE TABLE IF NOT EXISTS upload_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256         char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  parts          integer  NOT NULL CHECK (parts >= 1),
  bytes_total    bigint   NULL CHECK (bytes_total IS NULL OR bytes_total >= 0),
  expires_at     timestamptz NOT NULL,
  status         upload_status NOT NULL DEFAULT 'initiated',
  created_at     timestamptz NOT NULL DEFAULT now_utc(),
  updated_at     timestamptz NOT NULL DEFAULT now_utc(),
  completed_at   timestamptz NULL
);

COMMENT ON TABLE upload_sessions IS 'Инициализация и жизненный цикл multipart-загрузок (presigned).';

-- Один активный initiated на пользователя и sha256
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_upload_sessions_active'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_upload_sessions_active
             ON upload_sessions (user_id, sha256)
             WHERE status = ''initiated'' ';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_created ON upload_sessions (user_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_upload_sessions_set_updated_at ON upload_sessions;
CREATE TRIGGER trg_upload_sessions_set_updated_at
BEFORE UPDATE ON upload_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
