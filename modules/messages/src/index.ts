/**
 * MessagesService
 * Возможности:
 *  - sendText / sendMedia / sendSystem
 *  - list (keyset-пагинация по created_at DESC, id DESC)
 *  - receipts: markDelivered / markRead (per user)
 *  - delete (soft) и restore (опционально)
 *
 * Требования к БД:
 *  - conversations(id, last_message_at, deleted_at)
 *  - conversation_members(conversation_id, user_id, left_at, role)
 *  - messages(id uuid, conversation_id, sender_id, kind enum('text','media','system'),
 *             text, media_id uuid NULL, reply_to uuid NULL, deleted_at timestamptz NULL,
 *             created_at, updated_at)
 *  - message_receipts(message_id, user_id, delivered_at, read_at, PRIMARY KEY(message_id, user_id))
 *  - media_files(id uuid, ref_count int, quarantined bool, antivirus_status enum, owner_id, mime, ...)
 *
 * Бизнес-правила:
 *  - Отправлять может только участник беседы без left_at.
 *  - MEDIA: разрешено только если media.clean (antivirus_status <> 'infected' AND NOT quarantined).
 *  - reply_to должно ссылаться на сообщение из той же беседы.
 *  - Обновлять conversations.last_message_at при успешной отправке (NOW()).
 */

import { Pool } from 'pg';

export type Cursor = { ts: string; id: string };
export type MessageKind = 'text'|'media'|'system';

export type SendTextInput = {
  conversationId: string;
  senderId: string;
  text: string;
  replyTo?: string | null;
};

export type SendMediaInput = {
  conversationId: string;
  senderId: string;
  mediaId: string;       // ссылка на media_files
  caption?: string | null;
  replyTo?: string | null;
};

export type SendSystemInput = {
  conversationId: string;
  actorId: string;
  text: string;
  meta?: any;
};

export class MessagesService {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Отправка
  // ────────────────────────────────────────────────────────────────────────────

  async sendText(input: SendTextInput): Promise<{ id: string }> {
    this.ensureUuid(input.conversationId);
    this.ensureUuid(input.senderId);
    const text = (input.text ?? '').trim();
    if (!text) this.errThrow(400, 'text_required');
    if (input.replyTo) this.ensureUuid(input.replyTo);

    await this.ensureMember(input.conversationId, input.senderId);

    // reply_to проверка (если задан)
    if (input.replyTo) {
      const ok = await this.isMessageInConversation(input.replyTo, input.conversationId);
      if (!ok) this.errThrow(400, 'reply_to_invalid');
    }

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const q = await cli.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, text, reply_to)
         VALUES ($1, $2, 'text', $3, $4)
         RETURNING id`,
        [input.conversationId, input.senderId, text, input.replyTo ?? null]
      );
      const msgId = String(q.rows[0].id);

      // обновить last_message_at
      await cli.query(`UPDATE conversations SET last_message_at = now_utc(), updated_at = now_utc() WHERE id = $1`, [input.conversationId]);

      // квитанция отправителя «доставлено и прочитано» сразу
      await this.upsertReceipt(cli, msgId, input.senderId, { delivered: true, read: true });

      await cli.query('COMMIT');
      return { id: msgId };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  async sendMedia(input: SendMediaInput): Promise<{ id: string }> {
    this.ensureUuid(input.conversationId);
    this.ensureUuid(input.senderId);
    this.ensureUuid(input.mediaId);
    if (input.replyTo) this.ensureUuid(input.replyTo);
    await this.ensureMember(input.conversationId, input.senderId);

    // Проверим media доступность
    const m = await this.pool.query(
      `SELECT id, quarantined, antivirus_status FROM media_files WHERE id = $1`,
      [input.mediaId]
    );
    if (!m.rowCount) this.errThrow(404, 'media_not_found');
    const mr = m.rows[0];
    if (mr.quarantined === true || mr.antivirus_status === 'infected') {
      this.errThrow(400, 'media_blocked');
    }

    if (input.replyTo) {
      const ok = await this.isMessageInConversation(input.replyTo, input.conversationId);
      if (!ok) this.errThrow(400, 'reply_to_invalid');
    }

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');

      // инкремент ref_count
      await cli.query(`UPDATE media_files SET ref_count = ref_count + 1, updated_at = now_utc() WHERE id = $1`, [input.mediaId]);

      const q = await cli.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, text, media_id, reply_to)
         VALUES ($1, $2, 'media', $3, $4, $5)
         RETURNING id`,
        [input.conversationId, input.senderId, input.caption ?? null, input.mediaId, input.replyTo ?? null]
      );
      const msgId = String(q.rows[0].id);

      await cli.query(`UPDATE conversations SET last_message_at = now_utc(), updated_at = now_utc() WHERE id = $1`, [input.conversationId]);
      await this.upsertReceipt(cli, msgId, input.senderId, { delivered: true, read: true });

      await cli.query('COMMIT');
      return { id: msgId };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  /** Системное сообщение (например: добавление участника). Требует actor ∈ members. */
  async sendSystem(input: SendSystemInput): Promise<{ id: string }> {
    this.ensureUuid(input.conversationId);
    this.ensureUuid(input.actorId);
    const text = (input.text ?? '').trim();
    if (!text) this.errThrow(400, 'text_required');

    await this.ensureMember(input.conversationId, input.actorId);

    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const q = await cli.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, text)
         VALUES ($1, $2, 'system', $3)
         RETURNING id`,
        [input.conversationId, input.actorId, JSON.stringify({ text, meta: input.meta ?? null })]
      );
      const msgId = String(q.rows[0].id);

      await cli.query(`UPDATE conversations SET last_message_at = now_utc(), updated_at = now_utc() WHERE id = $1`, [input.conversationId]);
      await this.upsertReceipt(cli, msgId, input.actorId, { delivered: true, read: true });

      await cli.query('COMMIT');
      return { id: msgId };
    } catch (e) {
      try { await cli.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      cli.release();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Пагинация / получение
  // ────────────────────────────────────────────────────────────────────────────

  /** Список сообщений беседы (DESC), keyset по (created_at,id). */
  async list(userId: string, conversationId: string, opts: { limit?: number; cursor?: Cursor | null } = {}) {
    this.ensureUuid(userId); this.ensureUuid(conversationId);
    await this.ensureMember(conversationId, userId);

    const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
    const params: any[] = [conversationId, limit + 1];
    let where = 'deleted_at IS NULL';

    if (opts.cursor?.ts && opts.cursor?.id) {
      params.push(opts.cursor.ts, opts.cursor.id);
      where += ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
    }

    const q = await this.pool.query(
      `SELECT id, conversation_id, sender_id, kind, text, media_id, reply_to, created_at
         FROM messages
        WHERE conversation_id = $1 AND ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      params
    );

    const rows = q.rows;
    let nextCursor: Cursor | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      rows.length = limit;
      nextCursor = { ts: last.created_at, id: String(last.id) };
    }

    // Автоматически ставим delivered для непрочитанных входящих (опционально по флагу)
    return { items: rows, nextCursor };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Квитанции
  // ────────────────────────────────────────────────────────────────────────────

  async markDelivered(userId: string, conversationId: string, messageIds: string[]) {
    this.ensureUuid(userId); this.ensureUuid(conversationId);
    if (!Array.isArray(messageIds) || messageIds.length === 0) return { ok: true as const };
    await this.ensureMember(conversationId, userId);
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      for (const mid of messageIds) {
        this.ensureUuid(mid);
        const ok = await this.isMessageInConversation(mid, conversationId);
        if (!ok) continue;
        await this.upsertReceipt(cli, mid, userId, { delivered: true });
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

  async markRead(userId: string, conversationId: string, messageIds: string[]) {
    this.ensureUuid(userId); this.ensureUuid(conversationId);
    if (!Array.isArray(messageIds) || messageIds.length === 0) return { ok: true as const };
    await this.ensureMember(conversationId, userId);
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      for (const mid of messageIds) {
        this.ensureUuid(mid);
        const ok = await this.isMessageInConversation(mid, conversationId);
        if (!ok) continue;
        await this.upsertReceipt(cli, mid, userId, { delivered: true, read: true });
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

  // ────────────────────────────────────────────────────────────────────────────
  // Удаление / восстановление (опционально)
  // ────────────────────────────────────────────────────────────────────────────

  async softDelete(actorId: string, conversationId: string, messageId: string) {
    this.ensureUuid(actorId); this.ensureUuid(conversationId); this.ensureUuid(messageId);
    await this.ensureMember(conversationId, actorId);

    // Автор может удалить своё; owner/admin беседы могут удалить любое
    const can = await this.pool.query(
      `SELECT (sender_id = $1) AS is_author
         FROM messages
        WHERE id = $2 AND conversation_id = $3 AND deleted_at IS NULL
        LIMIT 1`,
      [actorId, messageId, conversationId]
    );
    if (!can.rowCount) this.errThrow(404, 'message_not_found');

    // проверим админство
    const role = await this.userRole(actorId, conversationId);
    const isAdmin = role === 'owner' || role === 'admin';
    const isAuthor = can.rows[0].is_author === true;
    if (!isAuthor && !isAdmin) this.errThrow(403, 'forbidden');

    await this.pool.query(`UPDATE messages SET deleted_at = now_utc(), updated_at = now_utc() WHERE id = $1`, [messageId]);
    return { ok: true as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private async ensureMember(conversationId: string, userId: string) {
    const q = await this.pool.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
      [conversationId, userId]
    );
    if (!q.rowCount) this.errThrow(403, 'not_a_member');
  }

  private async isMessageInConversation(messageId: string, conversationId: string): Promise<boolean> {
    const q = await this.pool.query(`SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 LIMIT 1`, [messageId, conversationId]);
    return q.rowCount > 0;
  }

  private async upsertReceipt(cli: any, messageId: string, userId: string, opts: { delivered?: boolean; read?: boolean }) {
    const delivered = opts.delivered ? 'now_utc()' : 'COALESCE(delivered_at, NULL)';
    const read = opts.read ? 'now_utc()' : 'COALESCE(read_at, NULL)';
    await cli.query(
      `INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
       VALUES ($1, $2, ${opts.delivered ? 'now_utc()' : 'NULL'}, ${opts.read ? 'now_utc()' : 'NULL'})
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET
         delivered_at = ${delivered},
         read_at = ${read},
         updated_at = now_utc()`,
      [messageId, userId]
    );
  }

  private async userRole(userId: string, conversationId: string): Promise<'owner'|'admin'|'member'|null> {
    const q = await this.pool.query(
      `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
      [conversationId, userId]
    );
    if (!q.rowCount) return null;
    return q.rows[0].role;
  }

  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) this.errThrow(400, 'invalid_uuid');
  }
  private errThrow(status: number, code: string): never {
    const e: any = new Error(code); e.statusCode = status; throw e;
  }
}
