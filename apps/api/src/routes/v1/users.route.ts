import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.guard';
import * as Users from '@modules/users';
import * as Auth from '@modules/auth';
import {
  UserDTO, RegisterBody, LoginBody, RefreshBody, UpdateProfileBody, ChangePasswordBody
} from '../../schemas/users.schema';

export default async function usersRoutes(app: FastifyInstance) {
  // POST /auth/register
  app.withTypeProvider().post('/auth/register', {
    schema: {
      summary: 'Register new user',
      tags: ['auth'],
      body: RegisterBody,
      response: {
        201: z.object({
          user: UserDTO,
          token_type: z.literal('Bearer'),
          access_token: z.string(),
          expires_in: z.number().int().positive(),
          refresh_token: z.string()
        })
      }
    }
  }, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const user = await Users.createUser({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      roles: [] // по умолчанию
    });
    const tokens = await Auth.issueTokens({
      id: user.id, email: user.email, roles: user.roles, scopes: []
    });
    reply.code(201).send({ user, ...tokens });
  });

  // POST /auth/login
  app.withTypeProvider().post('/auth/login', {
    schema: {
      summary: 'Login with email & password',
      tags: ['auth'],
      body: LoginBody,
      response: {
        200: z.object({
          user: UserDTO,
          token_type: z.literal('Bearer'),
          access_token: z.string(),
          expires_in: z.number().int().positive(),
          refresh_token: z.string()
        }),
        401: z.any()
      }
    }
  }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const rec = await Users.verifyPassword(body.email, body.password);
    if (!rec) return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    const user = {
      id: rec.id, email: rec.email, display_name: rec.display_name,
      roles: rec.roles, avatar_media_id: rec.avatar_media_id,
      created_at: rec.created_at, updated_at: rec.updated_at
    };
    const tokens = await Auth.issueTokens({
      id: user.id, email: user.email, roles: user.roles, scopes: []
    });
    return { user, ...tokens };
  });

  // POST /auth/refresh
  app.withTypeProvider().post('/auth/refresh', {
    schema: {
      summary: 'Rotate refresh and issue new tokens',
      tags: ['auth'],
      body: RefreshBody,
      response: {
        200: z.object({
          token_type: z.literal('Bearer'),
          access_token: z.string(),
          expires_in: z.number().int().positive(),
          refresh_token: z.string()
        }),
        401: z.any()
      }
    }
  }, async (req, reply) => {
    const { refresh_token } = RefreshBody.parse(req.body);
    try {
      const payload = await Auth.verifyRefresh(refresh_token);
      const user = await Users.getById(String(payload.sub));
      if (!user) return reply.code(401).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      const rotated = await Auth.rotateRefresh(refresh_token, {
        id: user.id, email: user.email, roles: user.roles, scopes: []
      });
      return rotated;
    } catch (e: any) {
      return reply.code(401).send({ error: { code: 'INVALID_REFRESH', message: e?.message || 'Invalid refresh token' } });
    }
  });

  // POST /auth/logout — отозвать refresh (и при желании access)
  app.withTypeProvider().post('/auth/logout', {
    schema: {
      summary: 'Logout (revoke refresh)',
      tags: ['auth'],
      body: RefreshBody,
      response: { 204: z.null() }
    }
  }, async (req, reply) => {
    const { refresh_token } = RefreshBody.parse(req.body);
    try {
      const payload = await Auth.verifyRefresh(refresh_token);
      await Auth.revokeJti(String(payload.jti));
    } catch {
      // игнорируем ошибки — делаем logout идемпотентным
    }
    reply.code(204).send(null);
  });

  // GET /users/me
  app.withTypeProvider().get('/users/me', {
    schema: {
      summary: 'My profile',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      response: { 200: UserDTO }
    },
    preHandler: [requireAuth()]
  }, async (req) => {
    // @ts-expect-error — from requireAuth
    const uid: string = req.user.id;
    const me = await Users.getById(uid);
    // по идее не может быть null (юзер существует, раз есть токен), но на всякий случай
    return me!;
  });

  // PATCH /users/me
  app.withTypeProvider().patch('/users/me', {
    schema: {
      summary: 'Update my profile',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      body: UpdateProfileBody,
      response: { 200: UserDTO }
    },
    preHandler: [requireAuth()]
  }, async (req) => {
    const body = UpdateProfileBody.parse(req.body);
    // @ts-expect-error — from requireAuth
    const uid: string = req.user.id;
    const updated = await Users.updateProfile(uid, body);
    return updated!;
  });

  // POST /users/me/password
  app.withTypeProvider().post('/users/me/password', {
    schema: {
      summary: 'Change my password',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      body: ChangePasswordBody,
      response: { 204: z.null(), 400: z.any() }
    },
    preHandler: [requireAuth()]
  }, async (req, reply) => {
    const body = ChangePasswordBody.parse(req.body);
    // @ts-expect-error — from requireAuth
    const uid: string = req.user.id;
    const ok = await Users.changePassword(uid, body.oldPassword, body.newPassword);
    if (!ok) return reply.code(400).send({ error: { code: 'INVALID_OLD_PASSWORD', message: 'Old password is incorrect' } });
    reply.code(204).send(null);
  });

  // (Опционально) GET /users — админ-листинг
  app.withTypeProvider().get('/users', {
    schema: {
      summary: 'List users (admin)',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      querystring: z.object({
        q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional()
      }),
      response: {
        200: z.object({
          items: z.array(UserDTO),
          nextCursor: z.string().nullable()
        })
      }
    },
    preHandler: [requireAuth(/* можно потребовать scope admin:users */)]
  }, async (req) => {
    const { q, limit, cursor } = req.query as any;
    return Users.listUsers({ q, limit, cursor });
  });
}
