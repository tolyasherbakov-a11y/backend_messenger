import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.guard';
import {
  createCommunity, getCommunityById, getCommunityByHandle, updateCommunity, deleteCommunity,
  listCommunities, joinCommunity, leaveCommunity, getMembership, setMemberRole, banMember, unbanMember, isOwner
} from '@modules/communities';
import {
  CommunityDTO, MemberDTO, CreateCommunityBody, UpdateCommunityBody, ListCommunitiesQuery
} from '../../schemas/communities.schema';

export default async function communitiesRoutes(app: FastifyInstance) {
  // Создать сообщество (любой аутентифицированный)
  app.withTypeProvider().post('/communities', {
    schema: {
      summary: 'Create community (channel or group)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      body: CreateCommunityBody,
      response: { 201: CommunityDTO }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const body = CreateCommunityBody.parse(req.body);
    // @ts-expect-error from requireAuth
    const uid: string = req.user.id;
    const c = await createCommunity({
      kind: body.kind,
      handle: body.handle,
      title: body.title,
      description: body.description ?? null,
      isPublic: body.isPublic ?? true,
      postingPolicy: body.postingPolicy ?? 'owners',
      ownerId: uid
    });
    reply.code(201).send(c);
  });

  // Список сообществ (публичный)
  app.withTypeProvider().get('/communities', {
    schema: {
      summary: 'List communities',
      tags: ['communities'],
      querystring: ListCommunitiesQuery,
      response: {
        200: z.object({
          items: z.array(CommunityDTO),
          nextCursor: z.string().nullable()
        })
      }
    }
  }, async (req) => {
    const q = ListCommunitiesQuery.parse(req.query);
    return listCommunities(q);
  });

  // Получить сообщество по id|handle (публичный)
  app.withTypeProvider().get('/communities/:idOrHandle', {
    schema: {
      summary: 'Get community by id or handle',
      tags: ['communities'],
      params: z.object({ idOrHandle: z.string() }),
      response: { 200: CommunityDTO, 404: z.any() }
    }
  }, async (req, reply) => {
    const { idOrHandle } = req.params as { idOrHandle: string };
    const data = idOrHandle.includes('-') || idOrHandle.length > 32
      ? await getCommunityById(idOrHandle)
      : await getCommunityByHandle(idOrHandle);
    if (!data) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });
    return data;
  });

  // Обновить сообщество (только владелец)
  app.withTypeProvider().patch('/communities/:id', {
    schema: {
      summary: 'Update community',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string() }),
      body: UpdateCommunityBody,
      response: { 200: CommunityDTO, 403: z.any(), 404: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // @ts-expect-error
    const uid: string = req.user.id;
    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });
    if (!(await isOwner(id, uid))) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only owner can update community' } });
    }
    const body = UpdateCommunityBody.parse(req.body);
    const updated = await updateCommunity(id, body);
    return updated!;
  });

  // Удалить сообщество (только владелец)
  app.withTypeProvider().delete('/communities/:id', {
    schema: {
      summary: 'Delete community',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string() }),
      response: { 204: z.null(), 403: z.any(), 404: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // @ts-expect-error
    const uid: string = req.user.id;
    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });
    if (!(await isOwner(id, uid))) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only owner can delete community' } });
    }
    const ok = await deleteCommunity(id);
    if (!ok) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });
    reply.code(204).send(null);
  });

  // Вступить / Подписаться
  app.withTypeProvider().post('/communities/:id/join', {
    schema: {
      summary: 'Join (group) or subscribe (channel)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string() }),
      response: { 200: MemberDTO, 400: z.any(), 404: z.any(), 403: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // @ts-expect-error
    const uid: string = req.user.id;
    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });
    if (!c.is_public) {
      // базовая политика — приватные не поддержаны в MVP
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Community is not public' } });
    }
    try {
      const m = await joinCommunity(id, uid);
      return m;
    } catch (e: any) {
      if (String(e?.message).includes('banned')) {
        return reply.code(403).send({ error: { code: 'BANNED', message: 'You are banned in this community' } });
      }
      throw e;
    }
  });

  // Покинуть / Отписаться
  app.withTypeProvider().post('/communities/:id/leave', {
    schema: {
      summary: 'Leave (group) or unsubscribe (channel)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string() }),
      response: { 204: z.null(), 400: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // @ts-expect-error
    const uid: string = req.user.id;
    const ok = await leaveCommunity(id, uid);
    if (!ok) return reply.code(400).send({ error: { code: 'NOT_ACTIVE', message: 'You are not active member' } });
    reply.code(204).send(null);
  });

  // Получить моё участие
  app.withTypeProvider().get('/communities/:id/members/me', {
    schema: {
      summary: 'Get my membership state',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string() }),
      response: { 200: MemberDTO.nullable() }
    },
    preHandler: [requireAuth()]
  }, async (req) => {
    const { id } = req.params as { id: string };
    // @ts-expect-error
    const uid: string = req.user.id;
    const m = await getMembership(id, uid);
    return m;
  });

  // Управление ролью участника (owner/admin)
  app.withTypeProvider().post('/communities/:id/members/:userId/role', {
    schema: {
      summary: 'Set member role (owner/admin only; owner to assign owner)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string(), userId: z.string() }),
      body: z.object({ role: z.enum(['owner','admin','moderator','member','subscriber']) }),
      response: { 200: MemberDTO, 403: z.any(), 404: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    // @ts-expect-error
    const actorId: string = req.user.id;

    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });

    const { role } = (req.body as any);
    try {
      const m = await setMemberRole(id, actorId, userId, role);
      if (!m) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
      return m;
    } catch (e: any) {
      if (String(e?.message).includes('forbidden')) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient privileges' } });
      }
      throw e;
    }
  });

  // Бан / Разбан
  app.withTypeProvider().post('/communities/:id/members/:userId/ban', {
    schema: {
      summary: 'Ban member (admin/owner)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string(), userId: z.string() }),
      response: { 200: MemberDTO, 403: z.any(), 404: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    // @ts-expect-error
    const actorId: string = req.user.id;
    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });

    try {
      const m = await banMember(id, actorId, userId);
      if (!m) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
      return m;
    } catch (e: any) {
      if (String(e?.message).includes('forbidden')) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient privileges' } });
      }
      throw e;
    }
  });

  app.withTypeProvider().post('/communities/:id/members/:userId/unban', {
    schema: {
      summary: 'Unban member (admin/owner)',
      tags: ['communities'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.string(), userId: z.string() }),
      response: { 200: MemberDTO, 403: z.any(), 404: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    // @ts-expect-error
    const actorId: string = req.user.id;
    const c = await getCommunityById(id);
    if (!c) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Community not found' } });

    try {
      const m = await unbanMember(id, actorId, userId);
      if (!m) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
      return m;
    } catch (e: any) {
      if (String(e?.message).includes('forbidden')) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient privileges' } });
      }
      throw e;
    }
  });
}
