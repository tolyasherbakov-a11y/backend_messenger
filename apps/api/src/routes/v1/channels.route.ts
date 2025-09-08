/**
 * Fastify routes: Channels
 *  GET    /v1/channels                        — каталог (keyset; query/visibility)
 *  POST   /v1/channels                        — создать канал (auth)
 *  GET    /v1/channels/:idOrSlug              — получить канал (учёт приватности)
 *  PATCH  /v1/channels/:id                    — изменить (title/about/visibility) (owner/admin)
 *  POST   /v1/channels/:id/publish            — опубликовать
 *  POST   /v1/channels/:id/archive            — архивировать
 *  POST   /v1/channels/:id/transfer           — передать владение {newOwnerId}
 *  POST   /v1/channels/:id/members            — добавить участников (owner/admin)
 *  DELETE /v1/channels/:id/members/:userId    — удалить участника / выйти
 *  PATCH  /v1/channels/:id/members/:userId    — изменить роль (owner/admin)
 *  POST   /v1/channels/:id/follow             — подписаться
 *  DELETE /v1/channels/:id/follow             — отписаться
 *  GET    /v1/channels/:id/follow             — статус подписки (auth)
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { ChannelsService } from '../../../../modules/channels/src/index';

const { DB_URL = 'postgres://app:app@postgres:5432/app' } = process.env;

function maybeUser(req: any): string | null {
  const uid = req.user?.id;
  return uid && /^[0-9a-f-]{36}$/i.test(String(uid)) ? String(uid) : null;
}
function requireUser(req: any): string {
  const uid = maybeUser(req);
  if (!uid) { const e: any = new Error('unauthorized'); e.statusCode = 401; throw e; }
  return uid;
}

export const channelsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    max: 20,
  });
  const svc = new ChannelsService(pool);

  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });

  // Каталог
  app.get('/v1/channels', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
          after_score: { type: 'number' },
          after_id: { type: 'string' },
          q: { type: 'string' },
          visibility: { type: 'string', enum: ['public','unlisted','private'] },
        },
      },
    },
    handler: async (req, reply) => {
      const { limit, after_score, after_id, q, visibility } = req.query as any;
      const res = await svc.list({
        limit: Number(limit) || 24,
        cursor: after_id && typeof after_score !== 'undefined' ? { id: String(after_id), score: Number(after_score) } : null,
        query: q ? String(q) : null,
        visibility: visibility || 'public',
      });
      return reply.send(res);
    },
  });

  // Создание
  app.post('/v1/channels', {
    schema: {
      body: {
        type: 'object',
        required: ['slug','title'],
        properties: {
          slug: { type: 'string' },
          title: { type: 'string' },
          about: { type: ['string','null'] },
          visibility: { type: 'string', enum: ['public','unlisted','private'] },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { slug, title, about, visibility } = req.body as any;
      const out = await svc.create(uid, { slug, title, about: about ?? null, visibility: visibility ?? 'public' });
      return reply.send(out);
    },
  });

  // Get by id or slug
  app.get('/v1/channels/:idOrSlug', {
    schema: { params: { type: 'object', required: ['idOrSlug'], properties: { idOrSlug: { type: 'string' } } } },
    handler: async (req, reply) => {
      const viewer = maybeUser(req);
      const { idOrSlug } = req.params as any;
      const out = await svc.getByIdOrSlug(viewer, String(idOrSlug));
      return reply.send({ channel: out });
    },
  });

  // Update basic
  app.patch('/v1/channels/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          title: { type: ['string','null'] },
          about: { type: ['string','null'] },
          visibility: { type: 'string', enum: ['public','unlisted','private'] },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const body = req.body as any;
      const out = await svc.update(uid, String(id), { title: body.title, about: body.about, visibility: body.visibility });
      return reply.send({ channel: out });
    },
  });

  // Publish / Archive
  app.post('/v1/channels/:id/publish', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.publish(uid, String(id));
      return reply.send(out);
    },
  });

  app.post('/v1/channels/:id/archive', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.archive(uid, String(id));
      return reply.send(out);
    },
  });

  // Transfer ownership
  app.post('/v1/channels/:id/transfer', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['newOwnerId'], properties: { newOwnerId: { type: 'string' } } },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const { newOwnerId } = req.body as any;
      const out = await svc.transferOwnership(uid, String(id), String(newOwnerId));
      return reply.send(out);
    },
  });

  // Members
  app.post('/v1/channels/:id/members', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['members'],
        properties: {
          members: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['userId'],
              properties: {
                userId: { type: 'string' },
                role: { type: 'string', enum: ['owner','admin','moderator','member'] },
              },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const { members } = req.body as any;
      const out = await svc.addMembers(uid, String(id), members);
      return reply.send(out);
    },
  });

  app.delete('/v1/channels/:id/members/:userId', {
    schema: { params: { type: 'object', required: ['id','userId'], properties: { id: { type: 'string' }, userId: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id, userId } = req.params as any;
      const out = await svc.removeMember(uid, String(id), String(userId));
      return reply.send(out);
    },
  });

  app.patch('/v1/channels/:id/members/:userId', {
    schema: {
      params: { type: 'object', required: ['id','userId'], properties: { id: { type: 'string' }, userId: { type: 'string' } } },
      body: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['admin','moderator','member'] } } },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id, userId } = req.params as any;
      const { role } = req.body as any;
      const out = await svc.updateMemberRole(uid, String(id), String(userId), role);
      return reply.send(out);
    },
  });

  // Follow
  app.post('/v1/channels/:id/follow', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.follow(uid, String(id));
      return reply.send(out);
    },
  });

  app.delete('/v1/channels/:id/follow', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.unfollow(uid, String(id));
      return reply.send(out);
    },
  });

  app.get('/v1/channels/:id/follow', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const following = await svc.isFollowing(uid, String(id));
      return reply.send({ following });
    },
  });
};

export default channelsRoutes;
