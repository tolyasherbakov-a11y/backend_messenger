import { describe, it, expect, vi } from 'vitest';

vi.mock('pg', () => ({ Pool: class {} }));
vi.mock('argon2', () => ({ hash: async () => '', verify: async () => true, argon2id: 0 }));
vi.mock('jose', () => {
  class SignJWTStub {
    constructor(private payload: any) {}
    setProtectedHeader() { return this; }
    setSubject(sub: string) { this.payload.sub = sub; return this; }
    setIssuedAt(iat: number) { this.payload.iat = iat; return this; }
    setIssuer(iss: string) { this.payload.iss = iss; return this; }
    setAudience(aud: string) { this.payload.aud = aud; return this; }
    setExpirationTime(exp: number) { this.payload.exp = exp; return this; }
    async sign(_secret: any) { return Buffer.from(JSON.stringify(this.payload)).toString('base64url'); }
  }
  async function jwtVerify(token: string, _secret: any, opts: any) {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (payload.iss !== opts.issuer || payload.aud !== opts.audience) throw new Error('bad');
    return { payload } as any;
  }
  return { SignJWT: SignJWTStub, jwtVerify };
});
import { AuthService } from '../modules/auth/src';

describe('AuthService.signAccessJwt', () => {
  it('includes payload and uses env vars', async () => {
    const svc = new AuthService({} as any, {
      AUTH_JWT_SECRET: 'a'.repeat(32),
      AUTH_JWT_ISSUER: 'https://issuer.example',
      AUTH_JWT_AUDIENCE: 'app',
    });
    const { token } = await (svc as any).signAccessJwt({ sub: 'user1', scope: 'read' });
    expect(typeof token).toBe('string');
    const payload = await svc.verifyAccessJwt(token);
    expect(payload.scope).toBe('read');
    expect(payload.iss).toBe('https://issuer.example');
    expect(payload.aud).toBe('app');
  });
});