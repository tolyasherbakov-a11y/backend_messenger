// apps/api/src/routes/v1/media.route.ts
import { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import * as Media from '@modules/media';
import { requireAuth } from '../../middleware/auth.guard';

/* ──────────────────────────────────────────────────────────────────────────
 * СХЕМЫ (Zod) → автоматически конвертируются в OpenAPI плагином openapi.ts
 * ────────────────────────────────────────────────────────────────────────── */
const IdParam = z.object({ id: z.string().min(1) });
const VariantParam = z.object({
  id: z.string().min(1),
  profile: z.string().min(1)
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional()
});

const MediaVariant = z.object({
  profile: z.string(),
  storageKey: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bitrate: z.number().int().nullable()
});

const MediaMeta = z.object({
  id: z.string(),
  sha256: z.string(),
  mime: z.string(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  variants: z.array(MediaVariant)
});

const MediaWithLinks = MediaMeta.extend({
  links: z.object({
    original: z.string().url().optional(),
    variants: z.record(z.string(), z.string().url()).optional()
  })
});

const ListResp = z.object({
  items: z.array(MediaMeta),
  nextCursor: z.string().nullable()
});

const PresignResp = z.object({ url: z.string().url() });

const ErrorResp = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.any().optional()
  })
});

/* ──────────────────────────────────────────────────────────────────────────
 * МАППИНГ ОШИБОК ДОМЕНА → HTTP
 * ────────────────────────────────────────────────────────────────────────── */
function sendMediaError(reply: any, err: any) {
  const code = err?.code || '';
  if (code === 'FORBIDDEN') {
    return reply.code(403).send({ error: { code, message: 'Forbidden' } });
  }
  if (code === 'NOT_FOUND') {
    return reply.code(404).send({ error: { code, message: 'Media not found' } });
  }
  if (code === 'VARIANT_NOT_FOUND') {
    return reply.code(404).send({ error: { code, message: 'Variant not found' } });
  }
  if (err?.name === 'ZodError') {
    return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues } });
  }
  return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

/* ──────────────────────────────────────────────────────────────────────────
 * РОУТЕР
 * ────────────────────────────────────────────────────────────────────────── */
const plugin: FastifyPluginCallback = (app, _opts, done) => {
  /**
   * GET /media/:id
   * Метаданные медиа с пресайн-ссылками (оригинал + все варианты).
   * Требует аутентификацию; ACL: владелец-только (до внедрения правил каналов/групп).
   */
  app.get('/media/:id', {
    schema: {
      tags: ['media'],
      summary: 'Get media metadata with presigned links (owner-only)',
      security: [{ bearerAuth: [] }],
      params: IdParam,
      response: {
        200: MediaWithLinks,
        400: ErrorResp,
        403: ErrorResp,
        404: ErrorResp,
        500: ErrorResp
      }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      // @ts-expect-error set by requireAuth
      const userId: string = req.user.id as string;
      const meta = await Media.getMetaWithLinks({ mediaId: id, requesterId: userId });
      reply.send(meta);
    } catch (err: any) {
      return sendMediaError(reply, err);
    }
  });

  /**
   * GET /media
   * Список моих медиа (без пресайнов), курсорная пагинация.
   */
  app.get('/media', {
    schema: {
      tags: ['media'],
      summary: 'List my media (cursor-based)',
      security: [{ bearerAuth: [] }],
      querystring: ListQuery,
      response: {
        200: ListResp,
        400: ErrorResp,
        401: ErrorResp,
        500: ErrorResp
      }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    try {
      const { limit, cursor } = ListQuery.parse(req.query);
      // @ts-expect-error set by requireAuth
      const userId: string = req.user.id as string;
      const res = await Media.listMyMedia({ userId, limit, cursor: cursor ?? undefined });
      reply.send(res);
    } catch (err: any) {
      return sendMediaError(reply, err);
    }
  });

  /**
   * GET /media/:id/original
   * Точечный пресайн на оригинал. Требует аутентификацию (владелец-только).
   */
  app.get('/media/:id/original', {
    schema: {
      tags: ['media'],
      summary: 'Get presigned URL for original media (owner-only)',
      security: [{ bearerAuth: [] }],
      params: IdParam,
      response: {
        200: PresignResp,
        400: ErrorResp,
        403: ErrorResp,
        404: ErrorResp
      }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      // @ts-expect-error set by requireAuth
      const userId: string = req.user.id as string;
      const url = await Media.getPresignedOriginal({ mediaId: id, requesterId: userId });
      reply.send(url);
    } catch (err: any) {
      return sendMediaError(reply, err);
    }
  });

  /**
   * GET /media/:id/variant/:profile
   * Точечный пресайн на конкретный вариант (например, 720p или thumb@256).
   */
  app.get('/media/:id/variant/:profile', {
    schema: {
      tags: ['media'],
      summary: 'Get presigned URL for a media variant (owner-only)',
      security: [{ bearerAuth: [] }],
      params: VariantParam,
      response: {
        200: PresignResp,
        400: ErrorResp,
        403: ErrorResp,
        404: ErrorResp
      }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    try {
      const { id, profile } = VariantParam.parse(req.params);
      // @ts-expect-error set by requireAuth
      const userId: string = req.user.id as string;
      const url = await Media.getPresignedVariant({ mediaId: id, profile, requesterId: userId });
      reply.send(url);
    } catch (err: any) {
      return sendMediaError(reply, err);
    }
  });

  done();
};

export default plugin;
