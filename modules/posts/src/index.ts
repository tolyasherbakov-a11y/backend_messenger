/**
 * PostsService
 * Возможности:
 *  - createDraft / update / attachMedia / publish / archive
 *  - getById, listByChannel (keyset), listFeed (keyset по score)
 *  - like / unlike (post_reactions), поддержка счётчиков в post_counters
 *
 * Требования к БД (миграции 008+):
 *  posts(id uuid, channel_id uuid, author_id uuid, title text, text text,
 *        media_id uuid NULL, state enum('draft','published','archived') DEFAULT 'draft',
 *        published_at timestamptz NULL, deleted_at timestamptz NULL,
 *        created_at timestamptz DEFAULT now_utc(), updated_at timestamptz)
 *  post_counters(post_id uuid PK, views bigint, likes bigint, comments bigint, reposts bigint, updated_at)
 *  post_reactions(post_id uuid, user_id uuid, type enum('like'), created_at, PRIMARY KEY(post_id,user_id,type))
 *  feed_events(id uuid, post_id uuid, channel_id uuid, author_id uuid, type text, created_at)
 *  channels(..., visibility enum, is_archived bool)
 *  channel_members(channel_id,user_id,left_at)
 *  channel_counters(channel_id PK, posts bigint, ...)
 *  media_files(id uuid, ref_count int, quarantined bool, antivirus_status enum)
 */

import { Pool } from 'pg';

export type CursorTSID = { ts: string; id: string };
export type CursorScore = { score: number; id: string };

export class PostsService {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Создание / изменение
  // ────────────────────────────────────────────────────────────────────────────

  /** Создать черновик поста в канале (автор должен быть членом канала и канал не архивный). */
  async createDraft(authorId: string, input: { channelId: string; title: string; text?: string | null; mediaId?: string | null }): Promise<{ id: string }> {
    this.ensureUuid(authorId); this.ensureUuid(input.channelId);
    const title = (input.title || '').trim();
    if (!title) this.errThrow(400, 'title_required');

    // Проверка членства и статуса канала
    await this.ensureChannelWritable(authorId, input.channelId);

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');

      // при привязке media — валидация/инкремент ref_count
      let mediaId: string | null = null;
      if (input.mediaId) {
        this.ensureUuid(input.mediaId);
        await this.assertMediaClean(cli, input.mediaId);
        await cli.query(`UPDATE media_files SET ref_count = ref_count + 1, updated_at = now_utc() WHERE id=$1`, [input.mediaId]);
        mediaId = input.mediaId;
      }

      const q = await cli.query(
        `INSERT INTO posts (channel_id, author_id, title, text, media_id, state)
         VALUES ($1, $2, $3, $4, $5, 'draft')
         RETURNING id`,
        [input.channelId, authorId, title, input.text ?? null, mediaId]
      );

      await this.ensurePostCounters(cli, q.rows[0].id);
      await cli.query('COMMIT');
      return { id: String(q.rows[0].id) };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  /** Обновить черновик/опубликованный пост (title/text). Право — автор или член с правом управления (owner/admin модуль каналов). */
  async update(actorId: string, postId: string, input: { title?: string | null; text?: string | null }) {
    this.ensureUuid(actorId); this.ensureUuid(postId);
    const info = await this.getPostCore(postId);
    await this.ensureCanEdit(actorId, info.channel_id, info.author_id);

    const sets: string[] = []; const vals: any[] = [];
    if (input.title !== undefined) { vals.push(input.title ?? null); sets.push(`title = $${vals.length}`); }
    if (input.text !== undefined) { vals.push(input.text ?? null); sets.push(`text = $${vals.length}`); }
    if (!sets.length) return this.getById(actorId, postId);

    vals.push(postId);
    await this.pool.query(`UPDATE posts SET ${sets.join(', ')}, updated_at = now_utc() WHERE id = $${vals.length}`, vals);
    return this.getById(actorId, postId);
  }

  /** Заменить/добавить медиа к посту. Инкремент/декремент ref_count корректно. */
  async attachMedia(actorId: string, postId: string, mediaId: string | null) {
    this.ensureUuid(actorId); this.ensureUuid(postId);
    const info = await this.getPostCore(postId);
    await this.ensureCanEdit(actorId, info.channel_id, info.author_id);

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');

      // старое медиа
      const old = await cli.query(`SELECT media_id FROM posts WHERE id=$1 FOR UPDATE`, [postId]);
      const oldId: string | null = old.rows[0].media_id;

      let newId: string | null = null;
      if (mediaId) {
        this.ensureUuid(mediaId);
        await this.assertMediaClean(cli, mediaId);
        await cli.query(`UPDATE media_files SET ref_count = ref_count + 1, updated_at = now_utc() WHERE id=$1`, [mediaId]);
        newId = mediaId;
      }

      // применяем обновление
      await cli.query(`UPDATE posts SET media_id=$1, updated_at=now_utc() WHERE id=$2`, [newId, postId]);

      // декремент для старого
      if (oldId && (!newId || oldId !== newId)) {
        await cli.query(`UPDATE media_files SET ref_count = GREATEST(0, ref_count - 1), updated_at = now_utc() WHERE id=$1`, [oldId]);
      }

      await cli.query('COMMIT');
      return this.getById(actorId, postId);
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  /** Опубликовать пост (меняет state, выставляет published_at, создаёт событие ленты, инкремент channel_counters.posts). */
  async publish(actorId: string, postId: string): Promise<{ ok: true }> {
    this.ensureUuid(actorId); this.ensureUuid(postId);
    const info = await this.getPostCore(postId);
    await this.ensureCanEdit(actorId, info.channel_id, info.author_id);
    await this.ensureChannelWritable(actorId, info.channel_id);

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const upd = await cli.query(
        `UPDATE posts
            SET state = 'published',
                published_at = COALESCE(published_at, now_utc()),
                updated_at = now_utc()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, channel_id, author_id, published_at`,
        [postId]
      );
      if (!upd.rowCount) this.errThrow(404, 'post_not_found');

      // событие ленты
      await cli.query(
        `INSERT INTO feed_events (post_id, channel_id, author_id, type, created_at)
         VALUES ($1, $2, $3, 'post_published', now_utc())`,
        [postId, info.channel_id, info.author_id]
      );

      // счётчик каналов
      await cli.query(
        `UPDATE channel_counters SET posts = posts + 1, updated_at = now_utc() WHERE channel_id=$1`,
        [info.channel_id]
      ).catch(() => {});

      await cli.query('COMMIT');
      return { ok: true as const };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  /** Архивировать (скрыть) пост. */
  async archive(actorId: string, postId: string): Promise<{ ok: true }> {
    this.ensureUuid(actorId); this.ensureUuid(postId);
    const info = await this.getPostCore(postId);
    await this.ensureCanEdit(actorId, info.channel_id, info.author_id);

    await this.pool.query(
      `UPDATE posts SET state='archived', updated_at=now_utc() WHERE id=$1`,
      [postId]
    );
    return { ok: true as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Чтение / выдача
  // ────────────────────────────────────────────────────────────────────────────

  async getById(viewerId: string | null, postId: string) {
    this.ensureUuid(postId);
    const q = await this.pool.query(
      `
      SELECT p.id, p.channel_id, p.author_id, p.title, p.text, p.media_id, p.state,
             p.published_at, p.created_at, p.updated_at,
             c.visibility, c.is_archived,
             COALESCE(pc.views,0) AS views, COALESCE(pc.likes,0) AS likes
        FROM posts p
        JOIN channels c ON c.id = p.channel_id
        LEFT JOIN post_counters pc ON pc.post_id = p.id
       WHERE p.id = $1 AND p.deleted_at IS NULL
       LIMIT 1
      `,
      [postId]
    );
    if (!q.rowCount) this.errThrow(404, 'post_not_found');

    const row = q.rows[0];
    // приватность канала
    if (row.visibility === 'private') {
      if (!viewerId) this.errThrow(403, 'forbidden');
      const m = await this.pool.query(
        `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
        [row.channel_id, viewerId]
      );
      if (!m.rowCount) this.errThrow(403, 'forbidden');
    }
    // в непубличных/архивных каналах показываем только участникам
    if ((row.is_archived === true) && viewerId) {
      const m = await this.pool.query(
        `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
        [row.channel_id, viewerId]
      );
      if (!m.rowCount) this.errThrow(403, 'forbidden');
    }
    return row;
  }

  /** Посты канала: state='published' (если viewer не член приватного канала — 403). */
  async listByChannel(viewerId: string | null, channelId: string, opts: { limit?: number; cursor?: CursorTSID | null } = {}) {
    this.ensureUuid(channelId);
    const limit = Math.min(Math.max(1, opts.limit ?? 24), 100);

    // проверка приватности
    const ch = await this.pool.query(`SELECT visibility FROM channels WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [channelId]);
    if (!ch.rowCount) this.errThrow(404, 'channel_not_found');
    if (ch.rows[0].visibility === 'private') {
      if (!viewerId) this.errThrow(403, 'forbidden');
      const m = await this.pool.query(
        `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
        [channelId, viewerId]
      );
      if (!m.rowCount) this.errThrow(403, 'forbidden');
    }

    const params: any[] = [channelId, limit + 1];
    let where = `p.channel_id = $1 AND p.state = 'published' AND p.deleted_at IS NULL`;
    if (opts.cursor?.ts && opts.cursor?.id) {
      params.push(opts.cursor.ts, opts.cursor.id);
      where += ` AND (p.published_at, p.id) < ($3::timestamptz, $4::uuid)`;
    }

    const q = await this.pool.query(
      `
      SELECT p.id, p.title, p.text, p.media_id, p.author_id, p.published_at,
             COALESCE(pc.views,0) AS views, COALESCE(pc.likes,0) AS likes
        FROM posts p
        LEFT JOIN post_counters pc ON pc.post_id = p.id
       WHERE ${where}
       ORDER BY p.published_at DESC, p.id DESC
       LIMIT $2
      `,
      params
    );

    const rows = q.rows;
    let nextCursor: CursorTSID | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      rows.length = limit;
      nextCursor = { ts: last.published_at, id: String(last.id) };
    }
    return { items: rows, nextCursor };
  }

  /** Общая лента: public и неархивные, сортировка по score (likes*2 + views + recent_boost) — keyset. */
  async listFeed(opts: { limit?: number; cursor?: CursorScore | null; query?: string | null } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? 24), 100);
    const query = (opts.query || '').trim();

    const params: any[] = [limit + 1];
    let where = `p.state = 'published' AND p.deleted_at IS NULL AND ch.visibility = 'public' AND ch.is_archived = false`;
    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (lower(p.title) LIKE $${params.length} OR lower(p.text) LIKE $${params.length})`;
    }

    const scoreExpr = `
      (COALESCE(pc.likes,0)*2 + COALESCE(pc.views,0) +
       CASE WHEN p.published_at > now_utc() - interval '7 days' THEN 10 ELSE 0 END)::bigint
    `;

    if (opts.cursor?.id) {
      params.push(opts.cursor.score, opts.cursor.id);
      where += ` AND (${scoreExpr}, p.id) < ($${params.length - 1}, $${params.length})`;
    }

    const q = await this.pool.query(
      `
      SELECT p.id, p.title, p.text, p.media_id, p.author_id, p.channel_id, p.published_at,
             COALESCE(pc.views,0) AS views, COALESCE(pc.likes,0) AS likes,
             ${scoreExpr} AS score
        FROM posts p
        JOIN channels ch ON ch.id = p.channel_id
        LEFT JOIN post_counters pc ON pc.post_id = p.id
       WHERE ${where}
       ORDER BY score DESC, p.id DESC
       LIMIT $1
      `,
      params
    );

    const rows = q.rows as any[];
    let nextCursor: CursorScore | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      rows.length = limit;
      nextCursor = { score: Number(last.score || 0), id: String(last.id) };
    }
    return { items: rows, nextCursor };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Реакции (лайки)
  // ────────────────────────────────────────────────────────────────────────────

  async like(userId: string, postId: string): Promise<{ liked: true }> {
    this.ensureUuid(userId); this.ensureUuid(postId);
    await this.pool.query(
      `INSERT INTO post_reactions (post_id, user_id, type, created_at)
       SELECT $1, $2, 'like', now_utc()
       WHERE EXISTS (SELECT 1 FROM posts WHERE id=$1 AND state='published' AND deleted_at IS NULL)
       ON CONFLICT (post_id, user_id, type) DO NOTHING`,
      [postId, userId]
    );
    await this.pool.query(
      `INSERT INTO post_counters (post_id, views, likes, comments, reposts, updated_at)
       VALUES ($1,0,1,0,0, now_utc())
       ON CONFLICT (post_id) DO UPDATE SET likes = post_counters.likes + 1, updated_at = now_utc()`,
      [postId]
    );
    return { liked: true as const };
  }

  async unlike(userId: string, postId: string): Promise<{ liked: false }> {
    this.ensureUuid(userId); this.ensureUuid(postId);
    const res = await this.pool.query(`DELETE FROM post_reactions WHERE post_id=$1 AND user_id=$2 AND type='like'`, [postId, userId]);
    if (res.rowCount) {
      await this.pool.query(
        `UPDATE post_counters SET likes = GREATEST(0, likes - 1), updated_at = now_utc() WHERE post_id=$1`,
        [postId]
      ).catch(() => {});
    }
    return { liked: false as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private async getPostCore(postId: string): Promise<{ channel_id: string; author_id: string }> {
    const q = await this.pool.query(`SELECT channel_id, author_id FROM posts WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [postId]);
    if (!q.rowCount) this.errThrow(404, 'post_not_found');
    return { channel_id: String(q.rows[0].channel_id), author_id: String(q.rows[0].author_id) };
  }

  private async ensureChannelWritable(userId: string, channelId: string) {
    // канал должен существовать и не быть архивированным
    const ch = await this.pool.query(`SELECT is_archived FROM channels WHERE id=$1 AND deleted_at IS NULL`, [channelId]);
    if (!ch.rowCount) this.errThrow(404, 'channel_not_found');
    if (ch.rows[0].is_archived === true) this.errThrow(400, 'channel_archived');

    // участник?
    const m = await this.pool.query(
      `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
      [channelId, userId]
    );
    if (!m.rowCount) this.errThrow(403, 'not_a_channel_member');
  }

  private async ensureCanEdit(actorId: string, channelId: string, authorId: string) {
    if (actorId === authorId) return;
    // иначе — нужен admin/owner в канале
    const r = await this.pool.query(
      `SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
      [channelId, actorId]
    );
    if (!r.rowCount) this.errThrow(403, 'forbidden');
    const role = String(r.rows[0].role);
    if (!(role === 'owner' || role === 'admin')) this.errThrow(403, 'forbidden');
  }

  private async assertMediaClean(cli: any, mediaId: string) {
    const m = await cli.query(
      `SELECT quarantined, antivirus_status FROM media_files WHERE id = $1`,
      [mediaId]
    );
    if (!m.rowCount) this.errThrow(404, 'media_not_found');
    const row = m.rows[0];
    if (row.quarantined === true || row.antivirus_status === 'infected') {
      this.errThrow(400, 'media_blocked');
    }
  }

  private async ensurePostCounters(cli: any, postId: string) {
    await cli.query(
      `INSERT INTO post_counters (post_id, views, likes, comments, reposts, updated_at)
       VALUES ($1,0,0,0,0, now_utc())
       ON CONFLICT (post_id) DO NOTHING`,
      [postId]
    );
  }

  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) this.errThrow(400, 'invalid_uuid');
  }
  private errThrow(status: number, code: string): never {
    const e: any = new Error(code); e.statusCode = status; throw e;
  }
}
