// server/apps/api/src/middleware/role.guard.ts
import { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.guard';

/**
 * Guard, который требует наличие хотя бы одной из ролей.
 * Использование:
 *   app.get('/admin', { preHandler: [requireRole('admin','owner')] }, handler)
 */
export function requireRole(...allowed: string[]) {
  if (!allowed.length) throw new Error('requireRole: at least one role must be provided');

  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    // Сначала базовая аутентификация (JWT/JWKS и т.п.)
    await requireAuth()(req, reply);
    // Если requireAuth уже ответил 401 — дальше не идём
    // @ts-expect-error req.user добавляется в requireAuth
    if (!req.user) return;

    // @ts-expect-error см. расширение FastifyRequest в auth.guard.ts
    const roles: string[] = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const ok = roles.some(r => allowed.includes(r));
    if (!ok) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient role' } });
    }
  };
}
