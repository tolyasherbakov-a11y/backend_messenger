/**
 * Fastify routes: Conversations
 *  GET    /v1/conversations              — список бесед (keyset)
 *  POST   /v1/conversations              — создать private/group
 *  GET    /v1/conversations/:id          — получить беседу с участниками
 *  PATCH  /v1/conversations/:id          — изменить title/topic (owner/admin)
 *  POST   /v1/conversations/:id/members  — добавить участников (owner/admin)
 *  DELETE /v1/conversations/:id/members/:userId  — удалить участника / покинуть
 *  POST   /v1/conversations/:id/leave    — выйти из беседы
 *  PATCH  /v1/conversations/:id/members/:userId  — роль/уведомления
 *
 * Требование: (req as any).user.id установлен (см. auth preHandler в main.ts).
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { ConversationsService } from '../../../../modules/conversations/src/index';

const { DB_URL = 'postgres://app:app@postgres:5432/app' } = process.env;

function requireUser(req: any) {
  const uid = req.user?.id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(String(uid))) {
    const e: any = new Error('unauthorized'); e.statusCode = 401; throw e;
  }
  return String(uid);
}

export const conversationsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    max: 20,
  });
  const svc = new ConversationsService(pool);

  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });

  // ────────────────────────────────────────────────────────────────────────────
  // LIST
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/v1/conversations', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          after_ts: { type: 'string', description: 'ISO timestamp of last item' },
          after_id: { type: 'string', description: 'UUID of last item' },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const { limit, after_ts, after_id } = req.query as any;
      const { items, nextCursor } = await svc.listForUser(userId, {
        limit: Number(limit) || 20,
        cursor: after_ts && after_id ? { ts: String(after_ts), id: String(after_id) } : null,
      });
      return reply.send({ items, nextCursor });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CREATE
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/conversations', {
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['private', 'group'] },
          otherUserId: { type: 'string' }, // для private
          title: { type: 'string' },       // для group
          topic: { type: ['string', 'null'] },
          members: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const body = req.body as any;
      if (body.type === 'private') {
        if (!body.otherUserId) return reply.code(400).send({ error: 'otherUserId_required' });
        const { id } = await svc.createPrivate(userId, String(body.otherUserId));
        return reply.send({ id });
      }
      if (!body.title) return reply.code(400).send({ error: 'title_required' });
      const { id } = await svc.createGroup(userId, {
        title: String(body.title),
        topic: body.topic ?? null,
        memberIds: Array.isArray(body.members) ? body.members.map(String) : [],
      });
      return reply.send({ id });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GET BY ID
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/v1/conversations/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const { id } = req.params as any;
      const conv = await svc.getById(userId, String(id));
      return reply.send({ conversation: conv });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PATCH (title/topic)
  // ────────────────────────────────────────────────────────────────────────────
  app.patch('/v1/conversations/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          topic: { type: ['string', 'null'] },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const { id } = req.params as any;
      const { title, topic } = req.body as any;
      const conv = await svc.updateConversation(userId, String(id), { title, topic });
      return reply.send({ conversation: conv });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ADD MEMBERS
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/conversations/:id/members', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['members'],
        properties: {
          members: {
            type: 'array',
            items: {
              type: 'object',
              required: ['userId'],
              properties: {
                userId: { type: 'string' },
                role: { type: 'string', enum: ['owner','admin','member'] },
              },
            },
            minItems: 1,
          },
        },
      },
    },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const { id } = req.params as any;
      const { members } = req.body as any;
      const res = await svc.addMembers(userId, String(id), members);
      return reply.send({ conversation: res });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // REMOVE MEMBER / LEAVE
  // ────────────────────────────────────────────────────────────────────────────
  app.delete('/v1/conversations/:id/members/:userId', {
    schema: {
      params: { type: 'object', required: ['id','userId'], properties: { id: { type: 'string' }, userId: { type: 'string' } } },
    },
    handler: async (req, reply) => {
      const actorId = requireUser(req);
      const { id, userId } = req.params as any;
      const out = await svc.removeMember(actorId, String(id), String(userId));
      return reply.send(out);
    },
  });

  app.post('/v1/conversations/:id/leave', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const userId = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.leave(userId, String(id));
      return reply.send(out);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // UPDATE MEMBER (role/notifications)
  // ────────────────────────────────────────────────────────────────────────────
  app.patch('/v1/conversations/:id/members/:userId', {
    schema: {
      params: { type: 'object', required: ['id','userId'], properties: { id: { type: 'string' }, userId: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['owner','admin','member'] },
          notifications: { type: ['object','null'] },
        },
      },
    },
    handler: async (req, reply) => {
      const actorId = requireUser(req);
      const { id, userId } = req.params as any;
      const { role, notifications } = req.body as any;
      const out = await svc.updateMemberSettings(actorId, String(id), String(userId), { role, notifications });
      return reply.send(out);
    },
  });
};

export default conversationsRoutes;
