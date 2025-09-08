// server/apps/api/src/schemas/media.schema.ts
import { z } from 'zod';

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const Mime = z.string().min(3).max(255);
export const StorageKey = z.string().min(3).max(1024);

export const MediaDTO = z.object({
  id: z.string(),
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  mime: z.string(),
  storage_key: StorageKey,
  created_by: z.string(),
  ref_count: z.number().int().nonnegative(),
  antivirus_status: z.enum(['pending','clean','infected','error']).nullable().optional(),
  width: z.number().int().nonnegative().nullable().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
  duration: z.number().int().nonnegative().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string()
});

export type Media = z.infer<typeof MediaDTO>;
