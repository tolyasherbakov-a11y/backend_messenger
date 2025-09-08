import { sql } from '@db/index';

export type Community = {
  id: string;
  kind: 'channel' | 'group';
  handle: string;
  title: string;
  description: string | null;
  owner_id: string;
  is_public: boolean;
  posting_policy: 'owners' | 'members';
  members_count: number;
  posts_count: number;
  created_at: string;
  updated_at: string;
};

export type Member = {
  community_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'moderator' | 'member' | 'subscriber';
  status: 'active' | 'banned' | 'left' | 'pending';
  joined_at: string;
  updated_at: string;
};

export type CreateInput = {
  kind: 'channel' | 'group';
  handle: string;
  title: string;
  description?: string | null;
  ownerId: string;
  isPublic?: boolean;
  postingPolicy?: 'owners' | 'members';
  id?: string;
};

export type UpdateInput = Partial<Pick<CreateInput, 'title' | 'description' | 'isPublic' | 'postingPolicy'>>;

export type ListParams = {
  kind?: 'channel' | 'group';
  q?: string;
  ownerId?: string;
  onlyPublic?: boolean;
  limit?: number;
  cursor?: string; // b64 "created_at|id"
};

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)); }

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

/* ─────────────────────────────
 * CRUD
 * ──────────────────────────── */

export async function createCommunity(input: CreateInput): Promise<Community> {
  const handle = input.handle.trim().toLowerCase();
  const title  = input.title.trim();
  const desc   = input.description ?? null;
  const isPublic = input.isPublic ?? true;
  const posting = input.postingPolicy ?? 'owners';

  const rows = await sql<Community[]>`
    INSERT INTO communities (id, kind, handle, title, description, owner_id, is_public, posting_policy)
    VALUES (${input.id ?? sql`replace(gen_random_uuid()::text, '-', '')`}, ${input.kind}, ${handle}, ${title}, ${desc}, ${input.ownerId}, ${isPublic}, ${posting})
    RETURNING *
  `;
  // создаём запись участника-владельца
  await sql/* sql */`
    INSERT INTO community_members (community_id, user_id, role, status)
    VALUES (${rows[0].id}, ${input.ownerId}, 'owner', 'active')
    ON CONFLICT (community_id, user_id) DO UPDATE
      SET role='owner', status='active', updated_at=now()
  `;
  return rows[0];
}

export async function getCommunityById(id: string): Promise<Community | null> {
  const rows = await sql<Community[]>`SELECT * FROM communities WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getCommunityByHandle(handle: string): Promise<Community | null> {
  const h = handle.trim().toLowerCase();
  const rows = await sql<Community[]>`SELECT * FROM communities WHERE handle = ${h} LIMIT 1`;
  return rows[0] ?? null;
}

export async function updateCommunity(id: string, patch: UpdateInput): Promise<Community | null> {
  const title = patch.title?.trim();
  const description = patch.description ?? undefined;
  const posting = patch.postingPolicy;
  const isPublic = patch.isPublic;

  const rows = await sql<Community[]>`
    UPDATE communities
       SET title = COALESCE(${title}, title),
           description = COALESCE(${description}, description),
           posting_policy = COALESCE(${posting}, posting_policy),
           is_public = COALESCE(${isPublic}, is_public),
           updated_at = now()
     WHERE id = ${id}
     RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteCommunity(id: string): Promise<boolean> {
  const res = await sql`DELETE FROM communities WHERE id = ${id}`;
  // @ts-ignore postgres.js compatibility
  const count = Number(res?.count ?? res?.rowCount ?? 0);
  return count > 0;
}

/* ─────────────────────────────
 * Listing / Search
 * ──────────────────────────── */
export async function listCommunities(params: ListParams): Promise<{ items: Community[]; nextCursor: string | null }> {
  const limit = clamp(params.limit ?? 20, 1, 100);
  const cur = decodeCursor(params.cursor);
  const q = params.q?.trim();
  const ownerId = params.ownerId;
  const onlyPublic = params.onlyPublic ?? false;
  const kind = params.kind;

  const where = sql`
    1=1
    ${kind ? sql`AND kind = ${kind}` : sql``}
    ${onlyPublic ? sql`AND is_public = TRUE` : sql``}
    ${ownerId ? sql`AND owner_id = ${ownerId}` : sql``}
    ${q ? sql`AND ((handle || ' ' || title || ' ' || coalesce(description,'')) ILIKE '%' || ${q} || '%')` : sql``}
    ${cur ? sql`AND (created_at, id) < (${cur.created_at}::timestamptz, ${cur.id})` : sql``}
  `;

  const rows = await sql<Community[]>`
    SELECT * FROM communities
    WHERE ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = encodeCursor(String(last.created_at), last.id);
  }
  return { items: rows.slice(0, limit), nextCursor };
}

/* ─────────────────────────────
 * Membership
 * ──────────────────────────── */
export async function getMembership(communityId: string, userId: string): Promise<Member | null> {
  const rows = await sql<Member[]>`
    SELECT * FROM community_members WHERE community_id = ${communityId} AND user_id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function isOwner(communityId: string, userId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM community_members WHERE community_id=${communityId} AND user_id=${userId} AND role='owner' AND status='active' LIMIT 1`;
  return rows.length > 0;
}
export async function isAdminOrOwner(communityId: string, userId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM community_members WHERE community_id=${communityId} AND user_id=${userId} AND role IN ('owner','admin') AND status='active' LIMIT 1`;
  return rows.length > 0;
}

export async function joinCommunity(communityId: string, userId: string): Promise<Member> {
  const c = await getCommunityById(communityId);
  if (!c) throw new Error('community_not_found');

  // если забанен — запретим
  const m = await getMembership(communityId, userId);
  if (m && m.status === 'banned') throw new Error('banned');

  const role: Member['role'] = c.kind === 'channel' ? 'subscriber' : 'member';

  const rows = await sql<Member[]>`
    INSERT INTO community_members (community_id, user_id, role, status)
    VALUES (${communityId}, ${userId}, ${role}, 'active')
    ON CONFLICT (community_id, user_id) DO UPDATE
      SET status = 'active',
          role = CASE WHEN community_members.role = 'owner' THEN 'owner' ELSE ${role} END,
          updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function leaveCommunity(communityId: string, userId: string): Promise<boolean> {
  // владелец не может «уйти» не передав владение — триггер базы предотвратит снятие последнего owner
  const res = await sql`
    UPDATE community_members
       SET status='left', updated_at=now()
     WHERE community_id=${communityId} AND user_id=${userId} AND status='active'
  `;
  // @ts-ignore
  const count = Number(res?.count ?? res?.rowCount ?? 0);
  return count > 0;
}

export async function setMemberRole(communityId: string, actorId: string, targetUserId: string, role: Member['role']): Promise<Member | null> {
  // только owner может назначать роли до 'owner'; admin может назначать moderator/member/subscriber
  const actorIsOwner = await isOwner(communityId, actorId);
  const actorIsAdmin = actorIsOwner ? true : await isAdminOrOwner(communityId, actorId);
  if (role === 'owner' && !actorIsOwner) throw new Error('forbidden');

  if (!actorIsOwner && !actorIsAdmin) throw new Error('forbidden');

  const rows = await sql<Member[]>`
    UPDATE community_members
       SET role=${role}, updated_at=now()
     WHERE community_id=${communityId} AND user_id=${targetUserId}
     RETURNING *
  `;
  return rows[0] ?? null;
}

export async function banMember(communityId: string, actorId: string, targetUserId: string): Promise<Member | null> {
  if (!(await isAdminOrOwner(communityId, actorId))) throw new Error('forbidden');
  const rows = await sql<Member[]>`
    UPDATE community_members
       SET status='banned', updated_at=now()
     WHERE community_id=${communityId} AND user_id=${targetUserId}
     RETURNING *
  `;
  return rows[0] ?? null;
}

export async function unbanMember(communityId: string, actorId: string, targetUserId: string): Promise<Member | null> {
  if (!(await isAdminOrOwner(communityId, actorId))) throw new Error('forbidden');
  const rows = await sql<Member[]>`
    UPDATE community_members
       SET status='active', updated_at=now()
     WHERE community_id=${communityId} AND user_id=${targetUserId}
     RETURNING *
  `;
  return rows[0] ?? null;
}
