/**
 * AuthService
 * - Регистрация (email+password) с Argon2id
 * - Логин: выдача access(JWT) + refresh(opaque), создание строки в auth_sessions (храним SHA-256 хэш)
 * - Ротация refresh: при refresh() создаёт новую сессию и помечает старую replaced_by
 * - Logout: revoke текущую refresh-сессию
 * - Управление сессиями: list(), revoke(sessionId)
 *
 * ENV (обязательные/рекомендуемые):
 *  AUTH_JWT_ISS            (напр. "messenger.api")
 *  AUTH_JWT_AUD            (напр. "messenger.web")
 *  AUTH_JWT_ACCESS_TTL     (в секундах, напр. 900 = 15 мин)
 *  AUTH_JWT_REFRESH_TTL    (в секундах, напр. 2592000 = 30 дней)
 *  AUTH_JWT_SECRET         (32+ байт; используется HMAC SHA-256 через 'jose')
 *  PASSWORD_MIN_LENGTH     (по умолчанию 8)
 */

import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, JWTPayload } from 'jose';

export type UserSafe = {
  id: string;
  email: string;
  displayName: string;
  nickname: string | null;
  roles: string[];
};

export type Tokens = {
  accessToken: string;
  accessExp: number;  // unix seconds
  refreshToken: string;
  refreshExp: number; // unix seconds
  sessionId: string;
};

export class AuthService {
  constructor(private pool: Pool, private env = process.env) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Публичные методы
  // ────────────────────────────────────────────────────────────────────────────

  async signup(input: { email: string; password: string; displayName?: string; nickname?: string | null }): Promise<UserSafe> {
    const email = this.normalizeEmail(input.email);
    const pwd = String(input.password || '');
    const minLen = Math.max(6, Number(this.env.PASSWORD_MIN_LENGTH) || 8);
    if (pwd.length < minLen) throw this.err(400, `password_too_short (min ${minLen})`);

    const hash = await argon2.hash(pwd, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const display = input.displayName?.trim() || email.split('@')[0];
    const nickname = input.nickname?.trim() || null;

    let user: UserSafe | null = null;
    try {
      const q = await this.pool.query(
        `INSERT INTO users (email, password_hash, display_name, nickname, roles)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, display_name, nickname, roles`,
        [email, hash, display, nickname, []]
      );
      const r = q.rows[0];
      user = { id: String(r.id), email: String(r.email), displayName: String(r.display_name), nickname: r.nickname, roles: r.roles || [] };
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('ux_users_email_alive')) throw this.err(409, 'email_already_exists');
      if (msg.includes('ux_users_nickname_alive')) throw this.err(409, 'nickname_already_exists');
      throw e;
    }
    if (!user) throw this.err(500, 'user_not_created');
    return user;
  }

  async login(input: { email: string; password: string; userAgent?: string; ipAddress?: string }): Promise<{ user: UserSafe; tokens: Tokens }> {
    const email = this.normalizeEmail(input.email);
    const q = await this.pool.query(
      `SELECT id, email, password_hash, display_name, nickname, roles, deleted_at
         FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
      [email]
    );
    if (!q.rowCount) throw this.err(401, 'invalid_credentials');

    const u = q.rows[0];
    const ok = await argon2.verify(String(u.password_hash), String(input.password || ''));
    if (!ok) throw this.err(401, 'invalid_credentials');

    const user: UserSafe = { id: String(u.id), email: String(u.email), displayName: String(u.display_name), nickname: u.nickname, roles: u.roles || [] };
    const tokens = await this.issueTokensAndSession(user.id, input.userAgent, input.ipAddress);
    return { user, tokens };
  }

  async refresh(input: { refreshToken: string; userAgent?: string; ipAddress?: string }): Promise<Tokens> {
    const token = String(input.refreshToken || '');
    const hash = this.hashRefresh(token);

    // Ищем активную сессию по хэшу
    const s = await this.pool.query(
      `SELECT id, user_id, revoked_at, replaced_by, expires_at
         FROM auth_sessions
        WHERE refresh_hash = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [hash]
    );
    if (!s.rowCount) throw this.err(401, 'invalid_refresh');

    const sess = s.rows[0];
    if (new Date(sess.expires_at).getTime() <= Date.now()) throw this.err(401, 'refresh_expired');

    // Ротация: создаём новую сессию, текущую ссылаем на новую
    const newTok = this.newOpaqueToken();
    const newHash = this.hashRefresh(newTok);
    const now = new Date();
    const refreshExp = this.addSeconds(now, this.refreshTtl());

    const q = await this.pool.query(
      `WITH new_sess AS (
         INSERT INTO auth_sessions (user_id, refresh_hash, user_agent, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id
       )
       UPDATE auth_sessions
          SET replaced_by = (SELECT id FROM new_sess), updated_at = now_utc()
        WHERE id = $6
       RETURNING (SELECT id FROM new_sess) AS new_id`,
      [sess.user_id, newHash, input.userAgent || null, input.ipAddress || null, refreshExp.toISOString(), sess.id]
    );

    const newSessionId = String(q.rows[0].new_id);
    // Возвращаем новые пары токенов
    const access = await this.signAccessJwt({ sub: String(sess.user_id) });
    return {
      accessToken: access.token,
      accessExp: access.exp,
      refreshToken: newTok,
      refreshExp: Math.floor(refreshExp.getTime() / 1000),
      sessionId: newSessionId,
    };
  }

  async logout(input: { refreshToken?: string; sessionId?: string }): Promise<{ ok: true }> {
    if (!input.refreshToken && !input.sessionId) throw this.err(400, 'token_or_session_required');

    if (input.refreshToken) {
      const hash = this.hashRefresh(String(input.refreshToken));
      await this.pool.query(
        `UPDATE auth_sessions SET revoked_at = now_utc(), updated_at = now_utc()
          WHERE refresh_hash = $1 AND revoked_at IS NULL`,
        [hash]
      );
      return { ok: true };
    }

    if (input.sessionId) {
      await this.pool.query(
        `UPDATE auth_sessions SET revoked_at = now_utc(), updated_at = now_utc()
          WHERE id = $1 AND revoked_at IS NULL`,
        [input.sessionId]
      );
      return { ok: true };
    }

    return { ok: true };
  }

  async listSessions(userId: string): Promise<Array<{
    id: string; createdAt: string; revokedAt: string | null; replacedBy: string | null; expiresAt: string;
    userAgent: string | null; ipAddress: string | null;
  }>> {
    this.ensureUuid(userId);
    const q = await this.pool.query(
      `SELECT id, created_at, revoked_at, replaced_by, expires_at, user_agent, ip_address
         FROM auth_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [userId]
    );
    return q.rows.map((r) => ({
      id: String(r.id),
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      replacedBy: r.replaced_by,
      expiresAt: r.expires_at,
      userAgent: r.user_agent,
      ipAddress: r.ip_address,
    }));
  }

  async revoke(userId: string, sessionId: string): Promise<{ ok: true }> {
    this.ensureUuid(userId);
    this.ensureUuid(sessionId);
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now_utc(), updated_at = now_utc()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId]
    );
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Внутреннее
  // ────────────────────────────────────────────────────────────────────────────

  private async issueTokensAndSession(userId: string, userAgent?: string, ipAddress?: string): Promise<Tokens> {
    const access = await this.signAccessJwt({ sub: userId });
    const refreshToken = this.newOpaqueToken();
    const refreshHash = this.hashRefresh(refreshToken);
    const now = new Date();
    const refreshExp = this.addSeconds(now, this.refreshTtl());

    const q = await this.pool.query(
      `INSERT INTO auth_sessions (user_id, refresh_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, refreshHash, userAgent || null, ipAddress || null, refreshExp.toISOString()]
    );
    const sessionId = String(q.rows[0].id);

    return {
      accessToken: access.token,
      accessExp: access.exp,
      refreshToken,
      refreshExp: Math.floor(refreshExp.getTime() / 1000),
      sessionId,
    };
  }

  private async signAccessJwt(payload: Partial<JWTPayload> & { sub: string }): Promise<{ token: string; exp: number }> {
    const iss = this.env.AUTH_JWT_ISS || 'messenger.api';
    const aud = this.env.AUTH_JWT_AUD || 'messenger.web';
    const ttl = this.accessTtl();
    const secret = this.jwtSecretKey(); // Uint8Array
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttl;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(payload.sub)
      .setIssuedAt(now)
      .setIssuer(iss)
      .setAudience(aud)
      .setExpirationTime(exp)
      .sign(secret);

    return { token, exp };
  }

  // Верификация access JWT (может понадобиться в middleware)
  async verifyAccessJwt(token: string): Promise<JWTPayload> {
    const secret = this.jwtSecretKey();
    const { payload } = await jwtVerify(token, secret, {
      issuer: this.env.AUTH_JWT_ISS || 'messenger.api',
      audience: this.env.AUTH_JWT_AUD || 'messenger.web',
    });
    return payload;
  }

  private accessTtl(): number {
    const s = Number(this.env.AUTH_JWT_ACCESS_TTL);
    return Number.isFinite(s) && s > 0 ? s : 900; // 15 минут по умолчанию
    }
  private refreshTtl(): number {
    const s = Number(this.env.AUTH_JWT_REFRESH_TTL);
    return Number.isFinite(s) && s > 0 ? s : 60 * 60 * 24 * 30; // 30 дней по умолчанию
  }

  private jwtSecretKey(): Uint8Array {
    const sec = this.env.AUTH_JWT_SECRET;
    if (!sec || sec.length < 32) throw this.err(500, 'AUTH_JWT_SECRET too short (>=32 chars)');
    return new TextEncoder().encode(sec);
  }

  private newOpaqueToken(): string {
    return randomBytes(48).toString('base64url'); // >64 символов URL-safe
  }
  private hashRefresh(refreshToken: string): string {
    return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
  }

  private normalizeEmail(email: string): string {
    return String(email || '').trim().toLowerCase();
  }
  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw this.err(400, 'invalid_uuid');
  }

  private addSeconds(d: Date, sec: number): Date {
    return new Date(d.getTime() + sec * 1000);
  }

  private err(status: number, code: string): any {
    const e: any = new Error(code);
    e.statusCode = status;
    return e;
  }
}
