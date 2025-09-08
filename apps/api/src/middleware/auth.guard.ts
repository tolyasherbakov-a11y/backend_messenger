// server/apps/api/src/middleware/auth.guard.ts
import { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, importSPKI, importPKCS8, importSecret, JWTPayload } from 'jose';
import { env } from '@config/index';
import { redis } from '@redis/index';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email?: string;
      roles?: string[];
      scope?: string;
      jti?: string;
    };
  }
}

let verifyKeyPromise: Promise<any> | null = null;

async function getVerifyKey(): Promise<any> {
  if (verifyKeyPromise) return verifyKeyPromise;
  verifyKeyPromise = (async () => {
    if (env.auth.publicKey) {
      // RS/EC/EdDSA public key
      return importSPKI(env.auth.publicKey.trim(), env.auth.signAlg as any || 'RS256');
    }
    if (env.auth.privateKey) {
      // Если задан только приватный ключ — можно верифицировать им же
      return importPKCS8(env.auth.privateKey.trim(), env.auth.signAlg as any || 'RS256');
    }
    if (env.auth.secret) {
      return importSecret(Buffer.from(env.auth.secret, 'utf8'));
    }
    throw new Error('Auth verify key not configured');
  })();
  return verifyKeyPromise;
}

export function requireAuth() {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } });

    const token = m[1];
    try {
      const key = await getVerifyKey();
      const { payload } = await jwtVerify(token, key, {
        issuer: env.auth.issuer,
        audience: env.auth.audience,
        clockTolerance: env.auth.clockLeewaySec
      });

      // Отзыв по jti
      const jti = String((payload as JWTPayload).jti || '');
      if (jti && redis) {
        const revoked = await redis.get(`auth:revoked:${jti}`);
        if (revoked) return reply.code(401).send({ error: { code: 'TOKEN_REVOKED', message: 'Token revoked' } });
      }

      req.user = {
        id: String(payload.uid || payload.sub),
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: Array.isArray(payload.roles) ? (payload.roles as any).map(String) : undefined,
        scope: typeof payload.scope === 'string' ? payload.scope : undefined,
        jti
      };
    } catch (e: any) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: e?.message || 'Invalid token' } });
    }
  };
}
