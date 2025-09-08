/**
 * Fastify routes for Auth:
 *  POST   /v1/auth/signup   {email, password, displayName?, nickname?}
 *  POST   /v1/auth/login    {email, password}
 *  POST   /v1/auth/refresh  {refreshToken}
 *  POST   /v1/auth/logout   {refreshToken?} | header Cookie если куки включены
 *  GET    /v1/auth/sessions  (auth required) → список активных сессий
 *  POST   /v1/auth/sessions/:id/revoke  (auth required) → отзыв указанной сессии
 *
 * Куки (опционально): если AUTH_COOKIES=true, то refresh передается/хранится в HttpOnly cookie "refresh_token".
 * В противном случае — только через JSON body.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { AuthService } from '../../../../modules/auth/src/index';

const {
  DB_URL = 'postgres://app:app@postgres:5432/app',
  AUTH_COOKIES = 'false',
  COOKIE_DOMAIN = '',
  COOKIE_SECURE = 'true',
  AUTH_JWT_ACCESS_TTL = '900',
} = process.env;

function cookieEnabled(): boolean {
  return String(AUTH_COOKIES).toLowerCase() === 'true';
}

function getUserFromAuthHeader(req: any): { userId: string } | null {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  // доверяем верификации ниже; здесь просто отдадим строку
  return { userId: '' }; // фактическая проверка будет через verifyAccessJwt
}

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const pool = new Pool({
    connectionString: DB_URL,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    max: 20,
  });
  const auth = new AuthService(pool);

  app.addHook('onClose', async () => {
    await pool.end().catch(() => {});
  });

  // Опционально подключим cookie плагин (если включены куки)
  if (cookieEnabled()) {
    // @ts-ignore — объявление внутри файла, чтобы не тащить зависимость на плагин глобально
    const fastifyCookie = (await import('@fastify/cookie')).default;
    await app.register(fastifyCookie, {});
  }

  const cookieOpts = {
    path: '/',
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: String(COOKIE_SECURE).toLowerCase() !== 'false',
    domain: COOKIE_DOMAIN || undefined,
    maxAge: 60 * 60 * 24 * 30, // 30d
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Signup
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/signup', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          displayName: { type: 'string' },
          nickname: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['user'],
          properties: {
            user: {
              type: 'object',
              required: ['id', 'email', 'displayName', 'roles'],
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                displayName: { type: 'string' },
                nickname: { type: ['string', 'null'] },
                roles: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const { email, password, displayName, nickname } = req.body as any;
      const user = await auth.signup({ email, password, displayName, nickname });
      return reply.send({ user });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Login
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['user', 'accessToken', 'accessExp', 'sessionId'],
          properties: {
            user: {
              type: 'object',
              required: ['id', 'email', 'displayName', 'roles'],
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                displayName: { type: 'string' },
                nickname: { type: ['string', 'null'] },
                roles: { type: 'array', items: { type: 'string' } },
              },
            },
            accessToken: { type: 'string' },
            accessExp: { type: 'integer' },
            sessionId: { type: 'string' },
            refreshToken: { type: 'string' },
            refreshExp: { type: 'integer' },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const { email, password } = req.body as any;
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-real-ip'] as string) || req.ip;
      const ua = req.headers['user-agent'] as string | undefined;
      const { user, tokens } = await auth.login({ email, password, ipAddress: ip, userAgent: ua });

      // Если куки включены — кладём refresh в HttpOnly cookie
      if (cookieEnabled()) {
        reply.setCookie('refresh_token', tokens.refreshToken, { ...cookieOpts, maxAge: tokens.refreshExp - Math.floor(Date.now() / 1000) });
      }

      return reply.send({
        user,
        accessToken: tokens.accessToken,
        accessExp: tokens.accessExp,
        sessionId: tokens.sessionId,
        // Отдаём refresh в body только если куки выключены
        ...(cookieEnabled() ? {} : { refreshToken: tokens.refreshToken, refreshExp: tokens.refreshExp }),
      });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Refresh
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        properties: { refreshToken: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          required: ['accessToken', 'accessExp', 'sessionId'],
          properties: {
            accessToken: { type: 'string' },
            accessExp: { type: 'integer' },
            sessionId: { type: 'string' },
            refreshToken: { type: 'string' },
            refreshExp: { type: 'integer' },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const token = cookieEnabled()
        ? (req.cookies?.refresh_token as string | undefined)
        : (req.body as any)?.refreshToken;

      if (!token) return reply.code(401).send({ error: 'no_refresh' });

      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-real-ip'] as string) || req.ip;
      const ua = req.headers['user-agent'] as string | undefined;
      const t = await auth.refresh({ refreshToken: token, ipAddress: ip, userAgent: ua });

      if (cookieEnabled()) {
        reply.setCookie('refresh_token', t.refreshToken, { ...cookieOpts, maxAge: t.refreshExp - Math.floor(Date.now() / 1000) });
        return reply.send({ accessToken: t.accessToken, accessExp: t.accessExp, sessionId: t.sessionId });
      }
      return reply.send(t);
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Logout
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/logout', {
    schema: {
      body: {
        type: 'object',
        properties: { refreshToken: { type: 'string' } },
      },
      response: { 200: { type: 'object', properties: { ok: { const: true } } } },
    },
    handler: async (req, reply) => {
      const token = cookieEnabled()
        ? (req.cookies?.refresh_token as string | undefined)
        : (req.body as any)?.refreshToken;

      if (!token) return reply.code(400).send({ error: 'no_refresh' });

      await auth.logout({ refreshToken: token });
      if (cookieEnabled()) {
        reply.clearCookie('refresh_token', { ...cookieOpts, maxAge: 0 });
      }
      return reply.send({ ok: true });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Дальше — защищённые маршруты: нужен действующий access JWT.
  // Упростим: проверим Authorization: Bearer и распарсим sub
  // ────────────────────────────────────────────────────────────────────────────
  app.addHook('preHandler', async (req, reply) => {
    // Пропускаем незащищённые
    if (req.routerPath?.startsWith('/v1/auth/') && !req.routerPath?.startsWith('/v1/auth/sessions')) return;
    const authz = req.headers['authorization'];
    if (!authz || typeof authz !== 'string') return; // другие маршруты сами проверят
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return;
    try {
      const payload = await auth.verifyAccessJwt(m[1]);
      (req as any).user = { id: String(payload.sub) };
    } catch (e) {
      // Ничего — конкретные защищённые обработчики сами вернут 401 если нужно
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GET /v1/auth/sessions  (auth required)
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/v1/auth/sessions', {
    handler: async (req, reply) => {
      const uid = (req as any).user?.id;
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const list = await auth.listSessions(uid);
      return reply.send({ sessions: list });
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /v1/auth/sessions/:id/revoke  (auth required)
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/sessions/:id/revoke', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const uid = (req as any).user?.id;
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const { id } = req.params as any;
      await auth.revoke(uid, id);
      return reply.send({ ok: true });
    },
  });
};

export default authRoutes;
