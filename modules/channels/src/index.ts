/**
 * ChannelsService
 * Возможности:
 *  - create / update / publish / archive / transferOwnership
 *  - follow / unfollow, чтение статуса подписки
 *  - getBySlugOrId, list (keyset по популярности и/или свежести)
 *  - addMembers / removeMember / updateMemberRole (owner/admin)
 *
 * Требования к БД (миграции 007 и окрестные):
 *  - channels(id uuid, owner_id uuid, slug citext UNIQUE, title text, about text,
 *             visibility enum('public','unlisted','private') default 'public',
 *             is_archived bool, created_at/updated_at, published_at timestamptz)
 *  - channel_members(channel_id uuid, user_id uuid, role enum('owner','admin','moderator','member'),
 *                    joined_at, left_at, UNIQUE(channel_id,user_id) WHERE left_at IS NULL)
 *  - channel_follows(channel_id uuid, user_id uuid, created_at, UNIQUE(channel_id,user_id))
 *  - channel_counters(channel_id uuid PK, followers bigint, posts bigint, views bigint, likes bigint, updated_at)
 *  - posts(id uuid, channel_id uuid, author_id uuid, title text, text text, media_id uuid,
 *          state enum('draft','published','archived'), published_at timestamptz, deleted_at)
 */

import { Pool } from 'pg';

export type ChannelVisibility = 'public'|'unlisted'|'private';
export type MemberRole = 'owner'|'admin'|'moderator'|'member';
export type Cursor = { score: number; id: string };

export class ChannelsService {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Создание/изменение
  // ────────────────────────────────────────────────────────────────────────────

  async create(ownerId: string, input: { slug: string; title: string; about?: string | null; visibility?: ChannelVisibility }): Promise<{ id: string }> {
    this.ensureUuid(ownerId);
    const slug = this.normSlug(input.slug);
    const title = (input.title || '').trim();
    if (!slug) this.errThrow(400, 'slug_required');
    if (!title) this.errThrow(400, 'title_required');

    try {
      const q = await this.pool.query(
        `INSERT INTO channels (owner_id, slug, title, about, visibility, is_archived, published_at)
         VALUES ($1, $2, $3, $4, $5, false, now_utc())
         RETURNING id`,
        [ownerId, slug, title, input.about ?? null, input.visibility ?? 'public']
      );
      const id = String(q.rows[0].id);
      // владелец становится членом (owner)
      await this.pool.query(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at, left_at)
         VALUES ($1, $2, 'owner', now_utc(), NULL)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET left_at = NULL, role='owner', updated_at = now_utc()`,
        [id, ownerId]
      );
      // завести счётчики
      await this.ensureCounters(id);
      return { id };
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('unique') && msg.includes('slug')) this.errThrow(409, 'slug_exists');
      throw e;
    }
  }

  async update(actorId: string, channelId: string, input: { title?: string | null; about?: string | null; visibility?: ChannelVisibility }) {
    this.ensureUuid(actorId); this.ensureUuid(channelId);
    const role = await this.memberRole(actorId, channelId);
    if (!role) this.errThrow(404, 'channel_not_found');
    if (!this.canManage(role)) this.errThrow(403, 'forbidden');

    const sets: string[] = []; const vals: any[] = [];
    if (input.title !== undefined) { vals.push(input.title ?? null); sets.push(`title = $${vals.length}`); }
    if (input.about !== undefined) { vals.push(input.about ?? null); sets.push(`about = $${vals.length}`); }
    if (input.visibility !== undefined) { vals.push(input.visibility); sets.push(`visibility = $${vals.length}`); }
    if (!sets.length) return this.getByIdOrSlug(actorId, channelId);

    vals.push(channelId);
    await this.pool.query(`UPDATE channels SET ${sets.join(', ')}, updated_at = now_utc() WHERE id = $${vals.length}`, vals);
    return this.getByIdOrSlug(actorId, channelId);
  }

  async publish(actorId: string, channelId: string): Promise<{ ok: true }> {
    this.ensureUuid(actorId); this.ensureUuid(channelId);
    const role = await this.memberRole(actorId, channelId);
    if (!role) this.errThrow(404, 'channel_not_found');
    if (!this.canManage(role)) this.errThrow(403, 'forbidden');
    await this.pool.query(`UPDATE channels SET is_archived = false, published_at = COALESCE(published_at, now_utc()), updated_at=now_utc() WHERE id=$1`, [channelId]);
    return { ok: true as const };
  }

  async archive(actorId: string, channelId: string): Promise<{ ok: true }> {
    this.ensureUuid(actorId); this.ensureUuid(channelId);
    const role = await this.memberRole(actorId, channelId);
    if (!role) this.errThrow(404, 'channel_not_found');
    if (!this.canManage(role)) this.errThrow(403, 'forbidden');
    await this.pool.query(`UPDATE channels SET is_archived = true, updated_at=now_utc() WHERE id=$1`, [channelId]);
    return { ok: true as const };
  }

  async transferOwnership(actorId: string, channelId: string, newOwnerId: string): Promise<{ ok: true }> {
    this.ensureUuid(actorId); this.ensureUuid(channelId); this.ensureUuid(newOwnerId);
    const role = await this.memberRole(actorId, channelId);
    if (role !== 'owner') this.errThrow(403, 'forbidden');

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      await cli.query(`UPDATE channels SET owner_id=$1, updated_at=now_utc() WHERE id=$2`, [newOwnerId, channelId]);
      // прежний владелец становится админом, новый — owner
      await cli.query(
        `INSERT INTO channel_members (channel_id, user_id, role, joined_at, left_at)
         VALUES ($1, $2, 'owner', now_utc(), NULL)
         ON CONFLICT (channel_id, user_id)
         DO UPDATE SET role='owner', left_at=NULL, updated_at=now_utc()`,
        [channelId, newOwnerId]
      );
      await cli.query(
        `UPDATE channel_members SET role='admin', updated_at=now_utc()
          WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL`,
        [channelId, actorId]
      );
      await cli.query('COMMIT');
      return { ok: true as const };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Участники
  // ────────────────────────────────────────────────────────────────────────────

  async addMembers(actorId: string, channelId: string, members: Array<{ userId: string; role?: MemberRole }>) {
    this.ensureUuid(actorId); this.ensureUuid(channelId);
    const role = await this.memberRole(actorId, channelId);
    if (!role) this.errThrow(404, 'channel_not_found');
    if (!this.canManage(role)) this.errThrow(403, 'forbidden');

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      for (const m of members) {
        this.ensureUuid(m.userId);
        const r = m.role ?? 'member';
        await cli.query(
          `INSERT INTO channel_members (channel_id, user_id, role, joined_at, left_at)
           VALUES ($1, $2, $3, now_utc(), NULL)
           ON CONFLICT (channel_id, user_id)
           DO UPDATE SET role=EXCLUDED.role, left_at=NULL, updated_at=now_utc()`,
          [channelId, m.userId, r]
        );
      }
      await cli.query('COMMIT');
      return { ok: true as const };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  async removeMember(actorId: string, channelId: string, memberId: string) {
    this.ensureUuid(actorId); this.ensureUuid(channelId); this.ensureUuid(memberId);
    const role = await this.memberRole(actorId, channelId);
    if (!role) this.errThrow(404, 'channel_not_found');
    // член может удалить себя; иначе — только admin/owner
    if (actorId !== memberId && !this.canManage(role)) this.errThrow(403, 'forbidden');

    // нельзя удалить последнего owner
    const r = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE role='owner' AND left_at IS NULL) AS owners,
              SUM(CASE WHEN user_id=$1 AND role='owner' AND left_at IS NULL THEN 1 ELSE 0 END) AS is_owner
         FROM channel_members
        WHERE channel_id=$2`,
      [memberId, channelId]
    );
    const owners = Number(r.rows[0].owners || 0);
    const isOwner = Number(r.rows[0].is_owner || 0) > 0;
    if (isOwner && owners <= 1) this.errThrow(400, 'cannot_remove_last_owner');

    await this.pool.query(
      `UPDATE channel_members SET left_at = now_utc(), updated_at = now_utc()
        WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL`,
      [channelId, memberId]
    );
    return { ok: true as const };
  }

  async updateMemberRole(actorId: string, channelId: string, memberId: string, role: MemberRole) {
    this.ensureUuid(actorId); this.ensureUuid(channelId); this.ensureUuid(memberId);
    const my = await this.memberRole(actorId, channelId);
    if (!my) this.errThrow(404, 'channel_not_found');
    if (!this.canManage(my)) this.errThrow(403, 'forbidden');
    if (role === 'owner') this.errThrow(400, 'use_transfer_ownership');

    await this.pool.query(
      `UPDATE channel_members SET role=$1, updated_at=now_utc()
        WHERE channel_id=$2 AND user_id=$3 AND left_at IS NULL`,
      [role, channelId, memberId]
    );
    return { ok: true as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Follow
  // ────────────────────────────────────────────────────────────────────────────

  async follow(userId: string, channelId: string): Promise<{ following: true }> {
    this.ensureUuid(userId); this.ensureUuid(channelId);
    await this.pool.query(
      `INSERT INTO channel_follows (channel_id, user_id, created_at)
       VALUES ($1, $2, now_utc())
       ON CONFLICT DO NOTHING`,
      [channelId, userId]
    );
    // Счётчик обновляет воркер/cron, но для UX можно оптимистично инкрементнуть:
    await this.pool.query(`UPDATE channel_counters SET followers = followers + 1, updated_at = now_utc() WHERE channel_id=$1`, [channelId]).catch(() => {});
    return { following: true as const };
  }

  async unfollow(userId: string, channelId: string): Promise<{ following: false }> {
    this.ensureUuid(userId); this.ensureUuid(channelId);
    await this.pool.query(`DELETE FROM channel_follows WHERE channel_id=$1 AND user_id=$2`, [channelId, userId]);
    await this.pool.query(`UPDATE channel_counters SET followers = GREATEST(0, followers - 1), updated_at = now_utc() WHERE channel_id=$1`, [channelId]).catch(() => {});
    return { following: false as const };
  }

  async isFollowing(userId: string, channelId: string): Promise<boolean> {
    this.ensureUuid(userId); this.ensureUuid(channelId);
    const q = await this.pool.query(`SELECT 1 FROM channel_follows WHERE channel_id=$1 AND user_id=$2 LIMIT 1`, [channelId, userId]);
    return q.rowCount > 0;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Чтение/выдача
  // ────────────────────────────────────────────────────────────────────────────

  async getByIdOrSlug(viewerId: string | null, idOrSlug: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const q = await this.pool.query(
      `
      SELECT c.id, c.slug, c.title, c.about, c.visibility, c.is_archived,
             c.owner_id, c.published_at, c.created_at, c.updated_at,
             coalesce(cc.followers,0) AS followers,
             coalesce(cc.posts,0) AS posts,
             coalesce(cc.views,0) AS views,
             coalesce(cc.likes,0) AS likes
        FROM channels c
        LEFT JOIN channel_counters cc ON cc.channel_id = c.id
       WHERE c.${isUuid ? 'id' : 'slug'} = $1
         AND c.deleted_at IS NULL
       LIMIT 1
      `,
      [idOrSlug]
    );
    if (!q.rowCount) this.errThrow(404, 'channel_not_found');

    const row = q.rows[0];
    // приватные каналы видят только участники
    if (row.visibility === 'private' && viewerId) {
      const m = await this.pool.query(
        `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
        [row.id, viewerId]
      );
      if (!m.rowCount) this.errThrow(403, 'forbidden');
    } else if (row.visibility === 'private' && !viewerId) {
      this.errThrow(403, 'forbidden');
    }
    return row;
  }

  /** Каталог каналов: keyset по вычисленному score (followers*2 + posts + recent_boost). */
  async list(opts: { limit?: number; cursor?: Cursor | null; query?: string | null; visibility?: ChannelVisibility }): Promise<{ items: any[]; nextCursor: Cursor | null }> {
    const limit = Math.min(Math.max(1, opts.limit ?? 24), 100);
    const query = (opts.query || '').trim();
    const visibility = opts.visibility ?? 'public';

    const params: any[] = [visibility, limit + 1];
    let where = `c.visibility = $1 AND c.is_archived = false AND c.deleted_at IS NULL`;
    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (lower(c.title) LIKE $${params.length} OR lower(c.about) LIKE $${params.length})`;
    }

    // score = followers*2 + posts + recent_boost (если опубликован в последние 14д)
    const scoreExpr = `
      (COALESCE(cc.followers,0)*2 + COALESCE(cc.posts,0) +
       CASE WHEN c.published_at > now_utc() - interval '14 days' THEN 10 ELSE 0 END)::bigint
    `;

    if (opts.cursor?.id) {
      params.push(opts.cursor.score, opts.cursor.id);
      where += ` AND (${scoreExpr}, c.id) < ($${params.length - 1}, $${params.length})`;
    }

    const q = await this.pool.query(
      `
      SELECT c.id, c.slug, c.title, c.about, c.visibility, c.is_archived,
             c.owner_id, c.published_at, c.created_at, c.updated_at,
             COALESCE(cc.followers,0) AS followers,
             COALESCE(cc.posts,0) AS posts,
             COALESCE(cc.views,0) AS views,
             COALESCE(cc.likes,0) AS likes,
             ${scoreExpr} AS score
        FROM channels c
        LEFT JOIN channel_counters cc ON cc.channel_id = c.id
       WHERE ${where}
       ORDER BY score DESC, c.id DESC
       LIMIT $2
      `,
      params
    );

    const rows = q.rows as any[];
    let nextCursor: Cursor | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      rows.length = limit;
      nextCursor = { score: Number(last.score || 0), id: String(last.id) };
    }
    return { items: rows, nextCursor };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Вспомогательные
  // ────────────────────────────────────────────────────────────────────────────

  private async ensureCounters(channelId: string) {
    await this.pool.query(
      `INSERT INTO channel_counters (channel_id, followers, posts, views, likes)
       VALUES ($1, 0, 0, 0, 0)
       ON CONFLICT (channel_id) DO NOTHING`,
      [channelId]
    );
  }

  private async memberRole(userId: string, channelId: string): Promise<MemberRole | null> {
    const q = await this.pool.query(
      `SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL LIMIT 1`,
      [channelId, userId]
    );
    if (!q.rowCount) return null;
    return q.rows[0].role as MemberRole;
  }

  private canManage(role: MemberRole): boolean {
    return role === 'owner' || role === 'admin';
  }

  private normSlug(s: string): string {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) this.errThrow(400, 'invalid_uuid');
  }
  private errThrow(status: number, code: string): never {
    const e: any = new Error(code); e.statusCode = status; throw e;
  }
}
