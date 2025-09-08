/**
 * Fastify routes: Messages
 *  GET    /v1/conversations/:cid/messages               — список (keyset)
 *  POST   /v1/conversations/:cid/messages               — отправка text|media
 *  POST   /v1/conversations/:cid/messages/receipts      — mark delivered/read
 *  DELETE /v1/conversations/:cid/messages/:mid          — soft delete
 *
 * Требование: (req as any).user.id установлен (см. auth preHandler).
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { MessagesService } from '../../../../modules/messages/src/index';

const { DB_URL = 'postgres://app:app@postgres:5432/app' } = process.env;

function requireUser(req: any) {
  const uid = req.user?.id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(String(uid))) {
    const e: any = new Error('unauthorized'); e.statusCode = 401; throw e;
  }
  return String(uid);
}

export const messagesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    max: 20,
  });
  const svc = new MessagesService(pool);

  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });

  // ────────────────────────────────────────────────────────────────────────────
  // LIST
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/v1/conversations/:cid/messages', {
    schema: {
      params: { type: 'object', required: ['cid'], properties: { cid: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
          after_ts: { type: 'string' },
          after_id: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { cid } = req.params as any;
      const { limit, after_ts, after_id } = req.query as any;
      const res = await svc.list(uid, String(cid), {
        limit: Number(limit) || 30,
        cursor: after_ts && after_id ? { ts: String(after_ts), id: String(after_id) } : null,
      });
      return reply.send(res);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SEND (text|media)
  // body: { kind: 'text', text, replyTo? } | { kind: 'media', mediaId, caption?, replyTo? }
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/conversations/:cid/messages', {
    schema: {
      params: { type: 'object', required: ['cid'], properties: { cid: { type: 'string' } } },
      body: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'text'],
            properties: {
              kind: { const: 'text' },
              text: { type: 'string', minLength: 1 },
              replyTo: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'mediaId'],
            properties: {
              kind: { const: 'media' },
              mediaId: { type: 'string' },
              caption: { type: 'string' },
              replyTo: { type: 'string' },
            },
          },
        ],
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { cid } = req.params as any;
      const body = req.body as any;
      if (body.kind === 'text') {
        const out = await svc.sendText({ conversationId: String(cid), senderId: uid, text: String(body.text), replyTo: body.replyTo ?? null });
        return reply.send(out);
      }
      if (body.kind === 'media') {
        const out = await svc.sendMedia({
          conversationId: String(cid),
          senderId: uid,
          mediaId: String(body.mediaId),
          caption: body.caption ?? null,
          replyTo: body.replyTo ?? null,
        });
        return reply.send(out);
      }
      return reply.code(400).send({ error: 'unsupported_kind' });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // RECEIPTS
  // body: { delivered?: string[], read?: string[] } — массивы messageId
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/conversations/:cid/messages/receipts', {
    schema: {
      params: { type: 'object', required: ['cid'], properties: { cid: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          delivered: { type: 'array', items: { type: 'string' } },
          read: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { cid } = req.params as any;
      const { delivered, read } = req.body as any;
      if (Array.isArray(delivered) && delivered.length) {
        await svc.markDelivered(uid, String(cid), delivered.map(String));
      }
      if (Array.isArray(read) && read.length) {
        await svc.markRead(uid, String(cid), read.map(String));
      }
      return reply.send({ ok: true });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DELETE (soft)
  // ────────────────────────────────────────────────────────────────────────────
  app.delete('/v1/conversations/:cid/messages/:mid', {
    schema: {
      params: { type: 'object', required: ['cid','mid'], properties: { cid: { type: 'string' }, mid: { type: 'string' } } },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { cid, mid } = req.params as any;
      const out = await svc.softDelete(uid, String(cid), String(mid));
      return reply.send(out);
    },
  });
};

export default messagesRoutes;
