-- ─────────────────────────────────────────────────────────────────────────────
-- 009_search.sql
-- Унифицированный полнотекстовый поиск по каналам, постам и сообщениям.
-- tsvector с unaccent, GIN-индекс, upsert-функция и триггеры на 3 таблицы.
-- Требования: 001, 004, 005, 007 применены ранее.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Расширение unaccent для нормализации (удаление диакритики)
CREATE EXTENSION IF NOT EXISTS unaccent;

-- В идеале для мультиязыка хранить параллельно вектора разных конфигов.
-- Для MVP используем "simple" через unaccent() – язык-нейтрально.
-- Таблица индекса
CREATE TABLE IF NOT EXISTS search_index (
  target_type  text NOT NULL CHECK (target_type IN ('channel','post','message')),
  target_id    uuid NOT NULL,
  tsv          tsvector NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now_utc(),
  updated_at   timestamptz NOT NULL DEFAULT now_utc(),
  PRIMARY KEY (target_type, target_id)
);

COMMENT ON TABLE search_index IS 'Единый полнотекстовый индекс каналов/постов/сообщений.';

CREATE INDEX IF NOT EXISTS gin_search_index_tsv
  ON search_index USING GIN (tsv);

DROP TRIGGER IF EXISTS trg_search_index_set_updated_at ON search_index;
CREATE TRIGGER trg_search_index_set_updated_at
BEFORE UPDATE ON search_index
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ── Функция сборки текста для целей
-- Для message индексируем только текстовые и системные с text IS NOT NULL.
CREATE OR REPLACE FUNCTION build_search_text(_target text, _id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  txt text;
BEGIN
  IF _target = 'channel' THEN
    SELECT
      COALESCE('@'||handle::text, '') || ' ' ||
      COALESCE(title, '') || ' ' ||
      COALESCE(description, '')
    INTO txt
    FROM channels
    WHERE id = _id AND deleted_at IS NULL;

  ELSIF _target = 'post' THEN
    SELECT
      COALESCE(title, '') || ' ' ||
      COALESCE(body, '')
    INTO txt
    FROM posts
    WHERE id = _id AND deleted_at IS NULL AND status <> 'deleted';

  ELSIF _target = 'message' THEN
    SELECT
      COALESCE(text, '')
    INTO txt
    FROM messages
    WHERE id = _id
      AND deleted_at IS NULL
      AND kind IN ('text','system')  -- медийные сообщения не индексируем по тексту
      ;
  ELSE
    RETURN NULL;
  END IF;

  RETURN NULLIF(btrim(COALESCE(txt,'')), '');
END;
$$;

-- ── Построение tsvector (unaccent + to_tsvector(simple))
CREATE OR REPLACE FUNCTION build_search_tsv(_text text)
RETURNS tsvector
LANGUAGE sql
STABLE
AS $$
  SELECT to_tsvector('simple', unaccent(COALESCE(_text, '')));
$$;

-- ── Upsert в search_index
CREATE OR REPLACE FUNCTION upsert_search_index(_target text, _id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  txt text;
  vec tsvector;
BEGIN
  txt := build_search_text(_target, _id);

  IF txt IS NULL OR length(txt) = 0 THEN
    -- Если текста нет (или объект удален), удаляем индексную запись
    DELETE FROM search_index WHERE target_type = _target AND target_id = _id;
    RETURN;
  END IF;

  vec := build_search_tsv(txt);

  INSERT INTO search_index (target_type, target_id, tsv)
  VALUES (_target, _id, vec)
  ON CONFLICT (target_type, target_id)
  DO UPDATE SET tsv = EXCLUDED.tsv, updated_at = now_utc();
END;
$$;

-- ── Обслуживающие функции-триггеры для каждой таблицы
CREATE OR REPLACE FUNCTION trg_channels_search_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM upsert_search_index('channel', NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trg_posts_search_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM upsert_search_index('post', NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trg_messages_search_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM upsert_search_index('message', NEW.id);
  RETURN NEW;
END;
$$;

-- ── Триггеры INSERT/UPDATE (и DELETE через ON DELETE)
-- Channels
DROP TRIGGER IF EXISTS t_channels_search_insupd ON channels;
CREATE TRIGGER t_channels_search_insupd
AFTER INSERT OR UPDATE OF handle, title, description, deleted_at
ON channels
FOR EACH ROW
EXECUTE FUNCTION trg_channels_search_refresh();

-- Posts
DROP TRIGGER IF EXISTS t_posts_search_insupd ON posts;
CREATE TRIGGER t_posts_search_insupd
AFTER INSERT OR UPDATE OF title, body, status, deleted_at
ON posts
FOR EACH ROW
EXECUTE FUNCTION trg_posts_search_refresh();

-- Messages (только изменения текстовой части и soft-delete)
DROP TRIGGER IF EXISTS t_messages_search_insupd ON messages;
CREATE TRIGGER t_messages_search_insupd
AFTER INSERT OR UPDATE OF text, kind, deleted_at
ON messages
FOR EACH ROW
EXECUTE FUNCTION trg_messages_search_refresh();

-- ── Чистка индекса при удалении строк-источников
-- Channels
DROP TRIGGER IF EXISTS t_channels_search_delete ON channels;
CREATE TRIGGER t_channels_search_delete
AFTER DELETE ON channels
FOR EACH ROW
EXECUTE FUNCTION
  -- используем простую анонимную функцию через DO? В PostgreSQL триггер требует функцию:
  -- создадим единый deleter:
  trg_search_delete();

-- Posts
DROP TRIGGER IF EXISTS t_posts_search_delete ON posts;
CREATE TRIGGER t_posts_search_delete
AFTER DELETE ON posts
FOR EACH ROW
EXECUTE FUNCTION trg_search_delete();

-- Messages
DROP TRIGGER IF EXISTS t_messages_search_delete ON messages;
CREATE TRIGGER t_messages_search_delete
AFTER DELETE ON messages
FOR EACH ROW
EXECUTE FUNCTION trg_search_delete();

-- Универсальная функция удаления из search_index по OLD
CREATE OR REPLACE FUNCTION trg_search_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  _type text;
  _id uuid;
BEGIN
  -- Определяем источник по TG_TABLE_NAME
  IF TG_TABLE_NAME = 'channels' THEN
    _type := 'channel';
    _id := OLD.id;
  ELSIF TG_TABLE_NAME = 'posts' THEN
    _type := 'post';
    _id := OLD.id;
  ELSIF TG_TABLE_NAME = 'messages' THEN
    _type := 'message';
    _id := OLD.id;
  ELSE
    RETURN NULL;
  END IF;

  DELETE FROM search_index WHERE target_type = _type AND target_id = _id;
  RETURN NULL;
END;
$$;

COMMIT;
