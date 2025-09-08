import argon2 from 'argon2';
import { sql } from '@db/index';

export type UserRecord = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  roles: string[];
  avatar_media_id: string | null;
  created_at: string;
  updated_at: string;
};

export type UserDTO = Omit<UserRecord, 'password_hash'>;

function toDTO(u: UserRecord): UserDTO {
  const { password_hash, ...rest } = u;
  return rest;
}

export async function getById(id: string): Promise<UserDTO | null> {
  const rows = await sql<UserRecord[]>`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function getByEmail(email: string): Promise<UserRecord | null> {
  const e = email.trim().toLowerCase();
  const rows = await sql<UserRecord[]>`SELECT * FROM users WHERE email = ${e} LIMIT 1`;
  return rows[0] ?? null;
}

export async function createUser(input: { email: string; password: string; displayName: string; roles?: string[] }): Promise<UserDTO> {
  const email = input.email.trim().toLowerCase();
  const hash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19456, // ~19MB
    timeCost: 2,
    parallelism: 1
  });

  let rows: UserRecord[];
  try {
    rows = await sql<UserRecord[]>`
      INSERT INTO users (email, password_hash, display_name, roles)
      VALUES (${email}, ${hash}, ${input.displayName}, ${input.roles ?? sql`'{}'::text[]`})
      RETURNING *
    `;
  } catch (e: any) {
    if (String(e?.message || '').includes('users_email_idx') || String(e?.message || '').includes('unique')) {
      throw new Error('email_taken');
    }
    throw e;
  }
  return toDTO(rows[0]);
}

export async function verifyPassword(email: string, password: string): Promise<UserRecord | null> {
  const rec = await getByEmail(email);
  if (!rec) return null;
  const ok = await argon2.verify(rec.password_hash, password);
  return ok ? rec : null;
}

export async function updateProfile(userId: string, patch: { displayName?: string; avatarMediaId?: string | null }): Promise<UserDTO | null> {
  const dn = patch.displayName?.trim();
  const av = patch.avatarMediaId;
  const rows = await sql<UserRecord[]>`
    UPDATE users
       SET display_name = COALESCE(${dn}, display_name),
           avatar_media_id = ${av}::text,
           updated_at = now()
     WHERE id = ${userId}
     RETURNING *
  `;
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
  const rows = await sql<UserRecord[]>`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
  if (!rows.length) return false;
  const rec = rows[0];
  const ok = await argon2.verify(rec.password_hash, oldPassword);
  if (!ok) return false;

  const hash = await argon2.hash(newPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
  await sql`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${userId}`;
  return true;
}

export async function listUsers(params: { q?: string; limit?: number; cursor?: string }): Promise<{ items: UserDTO[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(Number(params.limit ?? 20), 100));
  const q = params.q?.trim();
  const cur = decodeCursor(params.cursor);

  const where = sql`
    1=1
    ${q ? sql`AND (email ILIKE '%' || ${q} || '%' OR display_name ILIKE '%' || ${q} || '%')` : sql``}
    ${cur ? sql`AND (created_at, id) < (${cur.created_at}::timestamptz, ${cur.id})` : sql``}
  `;

  const rows = await sql<UserRecord[]>`
    SELECT * FROM users
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}
  `;
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = encodeCursor(String(last.created_at), last.id);
  }
  return { items: rows.slice(0, limit).map(toDTO), nextCursor };
}

function decodeCursor(c?: string | null): { created_at: string; id: string } | null {
  if (!c) return null;
  try {
    const raw = Buffer.from(String(c), 'base64').toString('utf8');
    const [ts, id] = raw.split('|');
    if (!ts || !id) return null;
    return { created_at: ts, id };
  } catch { return null; }
}
function encodeCursor(created_at: string, id: string) {
  return Buffer.from(`${created_at}|${id}`, 'utf8').toString('base64');
}
