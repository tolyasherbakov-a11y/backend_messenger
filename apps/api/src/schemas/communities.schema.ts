import { z } from 'zod';

export const CommunityDTO = z.object({
  id: z.string(),
  kind: z.enum(['channel','group']),
  handle: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  owner_id: z.string(),
  is_public: z.boolean(),
  posting_policy: z.enum(['owners','members']),
  members_count: z.number(),
  posts_count: z.number(),
  created_at: z.string(),
  updated_at: z.string()
});

export const MemberDTO = z.object({
  community_id: z.string(),
  user_id: z.string(),
  role: z.enum(['owner','admin','moderator','member','subscriber']),
  status: z.enum(['active','banned','left','pending']),
  joined_at: z.string(),
  updated_at: z.string()
});

export const CreateCommunityBody = z.object({
  kind: z.enum(['channel','group']),
  handle: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/),
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  isPublic: z.boolean().optional(),
  postingPolicy: z.enum(['owners','members']).optional()
});

export const UpdateCommunityBody = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  isPublic: z.boolean().optional(),
  postingPolicy: z.enum(['owners','members']).optional()
});

export const ListCommunitiesQuery = z.object({
  kind: z.enum(['channel','group']).optional(),
  q: z.string().max(200).optional(),
  ownerId: z.string().optional(),
  onlyPublic: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional()
});
