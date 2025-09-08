-- 011_user_avatar.sql
-- Add avatar_media_id column to users table for storing avatar media reference.

BEGIN;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS avatar_media_id uuid NULL REFERENCES media_files(id) ON DELETE SET NULL;

COMMIT;