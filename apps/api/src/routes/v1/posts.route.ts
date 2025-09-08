/**
 * Fastify routes: Posts & Feed
 *  POST   /v1/posts                         — создать черновик
 *  PATCH  /v1/posts/:id                     — обновить title/text
 *  POST   /v1/posts/:id/media               — привязать/заменить медиа {mediaId|null}
 *  POST   /v1/posts/:id/publish             — публикация
 *  POST   /v1/posts/:id/archive             — архив
 *  GET    /v1/posts/:id                     — получить пост (учёт приватности канала)
 *  GET    /v1/channels/:id/posts            — список постов канала (published; keyset)
 *  GET    /v1/feed                          — общая лента (public; keyset)
 *  POST   /v1/posts/:id/like                — лайк
 *  DELETE /v1/posts/:id/like                — анлайк
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { PostsService } from '../../../../modules/posts/src/index';

const { DB_URL = 'postgres://app:app@postgres:5432/app' } = process.env;

function requireUser(req: any): string {
  const uid = req.user?.id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(String(uid))) {
    const e: any = new Error('unauthorized'); e.statusCode = 401; throw e;
  }
  return String(uid);
}
function maybeUser(req: any): string | null {
  const uid = req.user?.id;
  return uid && /^[0-9a-f-]{36}$/i.test(String(uid)) ? String(uid) : null;
}

export const postsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    max: 20,
  });
  const svc = new PostsService(pool);

  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });

  // Create draft
  app.post('/v1/posts', {
    schema: {
      body: {
        type: 'object',
        required: ['channelId','title'],
        properties: {
          channelId: { type: 'string' },
          title: { type: 'string' },
          text: { type: ['string','null'] },
          mediaId: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { channelId, title, text, mediaId } = req.body as any;
      const out = await svc.createDraft(uid, { channelId: String(channelId), title: String(title), text: text ?? null, mediaId: mediaId ?? null });
      return reply.send(out);
    },
  });

  // Update
  app.patch('/v1/posts/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          title: { type: ['string','null'] },
          text: { type: ['string','null'] },
        },
      },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const body = req.body as any;
      const out = await svc.update(uid, String(id), { title: body.title, text: body.text });
      return reply.send({ post: out });
    },
  });

  // Attach/replace media
  app.post('/v1/posts/:id/media', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { mediaId: { type: ['string','null'] } } },
    },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const { mediaId } = req.body as any;
      const out = await svc.attachMedia(uid, String(id), mediaId ?? null);
      return reply.send({ post: out });
    },
  });

  // Publish
  app.post('/v1/posts/:id/publish', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.publish(uid, String(id));
      return reply.send(out);
    },
  });

  // Archive
  app.post('/v1/posts/:id/archive', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.archive(uid, String(id));
      return reply.send(out);
    },
  });

  // Get by id
  app.get('/v1/posts/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const viewer = maybeUser(req);
      const { id } = req.params as any;
      const post = await svc.getById(viewer, String(id));
      return reply.send({ post });
    },
  });

  // Channel posts
  app.get('/v1/channels/:id/posts', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
          after_ts: { type: 'string' },
          after_id: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const viewer = maybeUser(req);
      const { id } = req.params as any;
      const { limit, after_ts, after_id } = req.query as any;
      const res = await svc.listByChannel(viewer, String(id), {
        limit: Number(limit) || 24,
        cursor: after_ts && after_id ? { ts: String(after_ts), id: String(after_id) } : null,
      });
      return reply.send(res);
    },
  });

  // Feed
  app.get('/v1/feed', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
          after_score: { type: 'number' },
          after_id: { type: 'string' },
          q: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const { limit, after_score, after_id, q } = req.query as any;
      const res = await svc.listFeed({
        limit: Number(limit) || 24,
        cursor: after_id && typeof after_score !== 'undefined' ? { score: Number(after_score), id: String(after_id) } : null,
        query: q ? String(q) : null,
      });
      return reply.send(res);
    },
  });

  // Reactions: like/unlike
  app.post('/v1/posts/:id/like', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.like(uid, String(id));
      return reply.send(out);
    },
  });

  app.delete('/v1/posts/:id/like', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = requireUser(req);
      const { id } = req.params as any;
      const out = await svc.unlike(uid, String(id));
      return reply.send(out);
    },
  });
};

export default postsRoutes;
