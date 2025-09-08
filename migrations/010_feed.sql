-- ─────────────────────────────────────────────────────────────────────────────
-- 010_feed.sql
-- Сигналы и агрегаты для общей ленты: события просмотров/досмотров,
-- денормализованные счётчики по постам, таблица рейтингов/скорингов фида
-- и "пин" закрепленных объектов. Индексы под высокие нагрузки.
-- Требования: 001 (users), 007 (channels/posts).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── События просмотров видео/постов
-- Храним «сырые» события для аналитики и периодической агрегации.
-- event_kind: 'impression' (показ в фиде), 'open' (открыт пост),
-- 'start' (начат просмотр видео), 'progress' (прогресс), 'complete' (досмотр),
-- 'like'/'unlike', 'react'/'unreact'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_event_kind') THEN
    CREATE TYPE feed_event_kind AS ENUM (
      'impression','open','start','progress','complete','like','unlike','react','unreact'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS feed_events (
  id             bigserial PRIMARY KEY,
  user_id        uuid NULL REFERENCES users(id) ON DELETE SET NULL,  -- может быть NULL для анонимных
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  event_kind     feed_event_kind NOT NULL,
  value          numeric(10,3) NULL,  -- для progress/complete: доля (0..1) или секунды
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now_utc()
);

COMMENT ON TABLE feed_events IS 'Сырые события фида/просмотров/реакций для последующей агрегации.';

-- Индексы для скоростных выборок
CREATE INDEX IF NOT EXISTS idx_feed_events_post_created
  ON feed_events (post_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_events_user_created
  ON feed_events (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_events_kind_created
  ON feed_events (event_kind, created_at DESC, id DESC);

-- ── Денормализованные счётчики постов (ускорение выдачи и сортировок)
-- Обновляются воркером (пакетно) и/или триггерами приложения, в зависимости от нагрузки.
CREATE TABLE IF NOT EXISTS post_counters (
  post_id          uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  impressions      bigint NOT NULL DEFAULT 0,
  opens            bigint NOT NULL DEFAULT 0,
  starts           bigint NOT NULL DEFAULT 0,
  completes        bigint NOT NULL DEFAULT 0,
  avg_watch_ratio  numeric(6,4) NOT NULL DEFAULT 0,   -- средний досмотр 0..1
  likes            bigint NOT NULL DEFAULT 0,
  reactions        bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now_utc()
);

COMMENT ON TABLE post_counters IS 'Агрегированные счётчики по посту для ленты/ранжирования.';

CREATE INDEX IF NOT EXISTS idx_post_counters_likes
  ON post_counters (likes DESC, reactions DESC, completes DESC);

DROP TRIGGER IF EXISTS trg_post_counters_set_updated_at ON post_counters;
CREATE TRIGGER trg_post_counters_set_updated_at
BEFORE UPDATE ON post_counters
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Таблица скорингов (веса для ранжирования ленты)
-- score: предварительно вычисленная метрика "насколько пост релевантен".
-- segment: позволяет вести разные модели (global, fresh_24h, user:<id>, cohort:xxx).
CREATE TABLE IF NOT EXISTS feed_scores (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  segment    text NOT NULL,      -- напр. 'global' | 'fresh_24h' | 'user:<uuid>'
  score      numeric(18,6) NOT NULL,
  decay_ts   timestamptz NULL,   -- до какого момента score валиден без перерасчёта
  updated_at timestamptz NOT NULL DEFAULT now_utc(),
  PRIMARY KEY (post_id, segment)
);

COMMENT ON TABLE feed_scores IS 'Предрасчитанные скоринги постов по сегментам фида.';

CREATE INDEX IF NOT EXISTS idx_feed_scores_segment_score
  ON feed_scores (segment, score DESC, post_id);

DROP TRIGGER IF EXISTS trg_feed_scores_set_updated_at ON feed_scores;
CREATE TRIGGER trg_feed_scores_set_updated_at
BEFORE UPDATE ON feed_scores
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Пины/закрепление постов в ленте
-- Позволяет подмешивать редакторский/важный контент с приоритетом.
CREATE TABLE IF NOT EXISTS feed_pins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  segment     text NOT NULL DEFAULT 'global',
  priority    integer NOT NULL DEFAULT 100 CHECK (priority >= 0), -- меньше => выше
  starts_at   timestamptz NOT NULL DEFAULT now_utc(),
  ends_at     timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_pins_active
  ON feed_pins (segment, priority, starts_at)
  WHERE (ends_at IS NULL OR ends_at > now());

-- ── Материализованная денормализация для быстрых выдач (опционально)
-- Позволяет удерживать "топ" постов на заданный период. Обновляется воркером.
CREATE TABLE IF NOT EXISTS feed_materialized (
  segment     text NOT NULL,          -- сегмент
  ord         integer NOT NULL,       -- позиция в выдаче
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  score       numeric(18,6) NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now_utc(),
  PRIMARY KEY (segment, ord)
);

CREATE INDEX IF NOT EXISTS idx_feed_materialized_segment
  ON feed_materialized (segment, ord);

COMMIT;
