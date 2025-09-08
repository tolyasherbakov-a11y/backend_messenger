/**
 * ConversationsService
 * - createPrivate(otherUserId) / createGroup(title, members)
 * - listForUser(userId, opts) — keyset-пагинация по активности (last_message_at/created_at)
 * - getById(userId, conversationId) — с проверкой членства
 * - updateConversation(userId, conversationId, {title, topic}) — только owner/admin
 * - addMembers / removeMember / leave
 * - updateMemberSettings (role/notifications)
 *
 * Требования к БД: миграции 004_conversations.sql, 005_messages.sql применены.
 */

import { Pool } from 'pg';

export type Cursor = { ts: string; id: string }; // для keyset
export type MemberRole = 'owner' | 'admin' | 'member';
export type ConversationType = 'private' | 'group';

export class ConversationsService {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Создание
  // ────────────────────────────────────────────────────────────────────────────

  /** Создать приватный диалог (или вернуть существующий активный). */
  async createPrivate(userId: string, otherUserId: string): Promise<{ id: string }> {
    this.ensureUuid(userId); this.ensureUuid(otherUserId);
    if (userId === otherUserId) throw this.err(400, 'cannot_dm_self');

    // Ищем существующий private, где оба участника активны (left_at IS NULL)
    const q = await this.pool.query(
      `
      SELECT c.id
        FROM conversations c
        JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1 AND m1.left_at IS NULL
        JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2 AND m2.left_at IS NULL
       WHERE c.type = 'private' AND c.deleted_at IS NULL
       LIMIT 1
      `,
      [userId, otherUserId]
    );
    if (q.rowCount) return { id: String(q.rows[0].id) };

    // Создаем новую беседу и двух участников в транзакции
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const c = await cli.query(
        `INSERT INTO conversations (type, created_by, title)
         VALUES ('private', $1, NULL)
         RETURNING id`,
        [userId]
      );
      const convId = String(c.rows[0].id);
      await cli.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')
         ON CONFLICT DO NOTHING`,
        [convId, userId, otherUserId]
      );
      await cli.query('COMMIT');
      return { id: convId };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  /** Создать групповую беседу, установив владельца и участников. */
  async createGroup(ownerId: string, input: { title: string; topic?: string | null; memberIds?: string[] }): Promise<{ id: string }> {
    this.ensureUuid(ownerId);
    const title = (input.title || '').trim();
    if (!title) throw this.err(400, 'title_required');

    const memberIds = Array.from(new Set([...(input.memberIds || [])])).filter((id) => id !== ownerId);
    memberIds.forEach(this.ensureUuid);

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const c = await cli.query(
        `INSERT INTO conversations (type, created_by, title, topic)
         VALUES ('group', $1, $2, $3)
         RETURNING id`,
        [ownerId, title, input.topic ?? null]
      );
      const convId = String(c.rows[0].id);

      // Владелец — owner
      await cli.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT DO NOTHING`,
        [convId, ownerId]
      );

      // Остальные — member
      if (memberIds.length) {
        const values: any[] = [];
        const chunks: string[] = [];
        memberIds.forEach((uid, i) => {
          values.push(convId, uid);
          chunks.push(`($${values.length - 1}, $${values.length}, 'member')`);
        });
        await cli.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ${chunks.join(',')} ON CONFLICT DO NOTHING`, values);
      }

      await cli.query('COMMIT');
      return { id: convId };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Чтение / список
  // ────────────────────────────────────────────────────────────────────────────

  /** Получить беседу с базовой информацией, если пользователь — участник. */
  async getById(userId: string, conversationId: string) {
    this.ensureUuid(userId); this.ensureUuid(conversationId);

    const q = await this.pool.query(
      `
      SELECT c.id, c.type, c.title, c.topic, c.created_by, c.created_at, c.updated_at,
             c.last_message_at,
             (SELECT json_agg(json_build_object(
                 'userId', m.user_id, 'role', m.role, 'joinedAt', m.joined_at, 'leftAt', m.left_at,
                 'notifications', m.notifications
              ) ORDER BY m.joined_at ASC)
              FROM conversation_members m
              WHERE m.conversation_id = c.id AND (m.left_at IS NULL OR m.user_id = $1)
             ) AS members
        FROM conversations c
        JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1 AND me.left_at IS NULL
       WHERE c.id = $2 AND c.deleted_at IS NULL
       LIMIT 1
      `,
      [userId, conversationId]
    );
    if (!q.rowCount) throw this.err(404, 'conversation_not_found');
    return q.rows[0];
  }

  /** Список бесед пользователя с keyset-пагинацией по активности. */
  async listForUser(userId: string, opts: { limit?: number; cursor?: Cursor | null } = {}) {
    this.ensureUuid(userId);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);

    // Курсор: сортируем по coalesce(last_message_at, created_at) DESC, id DESC
    let where = '1=1';
    const params: any[] = [userId, limit + 1]; // +1 для nextCursor
    if (opts.cursor?.ts && opts.cursor?.id) {
      params.push(opts.cursor.ts, opts.cursor.id);
      where = ` (COALESCE(c.last_message_at, c.created_at), c.id) < ( $3::timestamptz, $4::uuid ) `;
    }

    const q = await this.pool.query(
      `
      SELECT c.id, c.type, c.title, c.topic, c.created_by, c.created_at, c.updated_at, c.last_message_at
        FROM conversations c
        JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = $1
         AND m.left_at IS NULL
         AND c.deleted_at IS NULL
         AND ${where}
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
       LIMIT $2
      `,
      params
    );

    const rows = q.rows as any[];
    let nextCursor: Cursor | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      rows.length = limit;
      nextCursor = { ts: last.last_message_at || last.created_at, id: String(last.id) };
    }
    return { items: rows, nextCursor };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Изменение беседы / участники
  // ────────────────────────────────────────────────────────────────────────────

  async updateConversation(actorId: string, conversationId: string, input: { title?: string | null; topic?: string | null }) {
    this.ensureUuid(actorId); this.ensureUuid(conversationId);

    // Проверим права — только owner/admin
    const can = await this.userRole(actorId, conversationId);
    if (!can) throw this.err(404, 'conversation_not_found');
    if (can.role === 'member') throw this.err(403, 'forbidden');

    const title = input.title === undefined ? undefined : (input.title ?? null);
    const topic = input.topic === undefined ? undefined : (input.topic ?? null);

    const sets: string[] = [];
    const vals: any[] = [];
    if (title !== undefined) { vals.push(title); sets.push(`title = $${vals.length}`); }
    if (topic !== undefined) { vals.push(topic); sets.push(`topic = $${vals.length}`); }
    if (!sets.length) return this.getById(actorId, conversationId);

    vals.push(conversationId);
    const sql = `UPDATE conversations SET ${sets.join(', ')}, updated_at = now_utc() WHERE id = $${vals.length} RETURNING id`;
    await this.pool.query(sql, vals);

    return this.getById(actorId, conversationId);
  }

  /** Добавить участников (owner/admin). */
  async addMembers(actorId: string, conversationId: string, members: Array<{ userId: string; role?: MemberRole }>) {
    this.ensureUuid(actorId); this.ensureUuid(conversationId);
    const can = await this.userRole(actorId, conversationId);
    if (!can) throw this.err(404, 'conversation_not_found');
    if (can.role === 'member') throw this.err(403, 'forbidden');

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      for (const m of members) {
        this.ensureUuid(m.userId);
        const role = m.role ?? 'member';
        await cli.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, left_at)
           VALUES ($1, $2, $3, now_utc(), NULL)
           ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET left_at = NULL, role = EXCLUDED.role, updated_at = now_utc()`,
          [conversationId, m.userId, role]
        );
      }
      await cli.query('COMMIT');
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }

    return this.getById(actorId, conversationId);
  }

  /** Удалить участника (owner/admin). Нельзя удалить последнего owner. */
  async removeMember(actorId: string, conversationId: string, memberId: string) {
    this.ensureUuid(actorId); this.ensureUuid(conversationId); this.ensureUuid(memberId);
    const can = await this.userRole(actorId, conversationId);
    if (!can) throw this.err(404, 'conversation_not_found');
    if (can.role === 'member' && actorId !== memberId) throw this.err(403, 'forbidden');

    // Проверка: не последний owner
    const r = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE role='owner' AND left_at IS NULL) AS owners,
              SUM(CASE WHEN user_id=$1 AND role='owner' AND left_at IS NULL THEN 1 ELSE 0 END) AS is_owner
         FROM conversation_members
        WHERE conversation_id=$2`,
      [memberId, conversationId]
    );
    const owners = Number(r.rows[0].owners || 0);
    const isOwner = Number(r.rows[0].is_owner || 0) > 0;
    if (isOwner && owners <= 1) throw this.err(400, 'cannot_remove_last_owner');

    await this.pool.query(
      `UPDATE conversation_members
          SET left_at = now_utc(), updated_at = now_utc()
        WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL`,
      [conversationId, memberId]
    );
    return { ok: true as const };
  }

  /** Выйти из беседы (участник помечается left_at). Нельзя покинуть, если ты последний owner. */
  async leave(userId: string, conversationId: string) {
    return this.removeMember(userId, conversationId, userId);
  }

  /** Изменить роль участника или настройки уведомлений. Только owner/admin. */
  async updateMemberSettings(actorId: string, conversationId: string, memberId: string, input: { role?: MemberRole; notifications?: any }) {
    this.ensureUuid(actorId); this.ensureUuid(conversationId); this.ensureUuid(memberId);
    const can = await this.userRole(actorId, conversationId);
    if (!can) throw this.err(404, 'conversation_not_found');
    if (can.role === 'member' && actorId !== memberId) throw this.err(403, 'forbidden');

    const sets: string[] = []; const vals: any[] = [];
    if (input.role) { vals.push(input.role); sets.push(`role = $${vals.length}`); }
    if (input.notifications !== undefined) { vals.push(JSON.stringify(input.notifications)); sets.push(`notifications = $${vals.length}::jsonb`); }
    if (!sets.length) return { ok: true as const };

    vals.push(conversationId, memberId);
    await this.pool.query(
      `UPDATE conversation_members SET ${sets.join(', ')}, updated_at = now_utc()
        WHERE conversation_id = $${vals.length - 1} AND user_id = $${vals.length} AND left_at IS NULL`,
      vals
    );
    return { ok: true as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Вспомогательные
  // ────────────────────────────────────────────────────────────────────────────

  private async userRole(userId: string, conversationId: string): Promise<{ role: MemberRole } | null> {
    const q = await this.pool.query(
      `SELECT role FROM conversation_members
        WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL
        LIMIT 1`,
      [conversationId, userId]
    );
    if (!q.rowCount) return null;
    return { role: q.rows[0].role as MemberRole };
  }

  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw this.err(400, 'invalid_uuid');
  }
  private err(status: number, code: string): any {
    const e: any = new Error(code); e.statusCode = status; return e;
  }
}
