/**
 * /v1/search и /v1/search/suggest
 *
 * Особенности:
 *  - Zod-схемы входа
 *  - Ограничение лимитов, курсорная пагинация
 *  - CORS/ACL: доступ для авторизованных (при необходимости — ослабьте)
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import SearchService, { SearchType } from '../../../../modules/search/src/index';

function requireUser(req: any) {
  const uid = req.user?.id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(String(uid))) {
    const e: any = new Error('unauthorized'); e.statusCode = 401; throw e;
  }
  return String(uid);
}

const TYPES = ['message', 'post', 'channel', 'user'] as const;

const searchQuerySchema = z.object({
  q: z.string().default(''),
  types: z.array(z.enum(TYPES)).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  sort: z.enum(['relevance', 'recency']).default('relevance').optional(),
});

const suggestQuerySchema = z.object({
  q: z.string(),
  types: z.array(z.enum(TYPES)).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

export const searchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const svc = new SearchService();

  // Основной поиск
  app.get('/v1/search', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          types: { type: 'array', items: { type: 'string', enum: TYPES as any } },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          cursor: { type: 'string' },
          sort: { type: 'string', enum: ['relevance', 'recency'] },
        },
      },
    },
    handler: async (req, reply) => {
      requireUser(req); // если поиск публичный — уберите это
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const e: any = new Error('bad_request'); e.statusCode = 400; e.details = parsed.error.format(); throw e;
      }
      const result = await svc.search(parsed.data);
      return reply.send(result);
    },
  });

  // Подсказки
  app.get('/v1/search/suggest', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          types: { type: 'array', items: { type: 'string', enum: TYPES as any } },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['q'],
      },
    },
    handler: async (req, reply) => {
      requireUser(req);
      const parsed = suggestQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const e: any = new Error('bad_request'); e.statusCode = 400; e.details = parsed.error.format(); throw e;
      }
      const result = await svc.suggest(parsed.data);
      return reply.send(result);
    },
  });
};

export default searchRoutes;
