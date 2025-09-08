// server/apps/api/src/schemas/uploads.schema.ts
import { z } from 'zod';
import { Sha256, StorageKey, MediaDTO } from './media.schema';

export const PresignBody = z.object({
  sha256: Sha256,
  filename: z.string().min(1).max(180),
  mime: z.string().min(3).max(255),
  size: z.number().int().positive().max(2_147_483_647) // ~2GB (настройте под свой лимит)
});

export const PresignResponse = z.object({
  exists: z.boolean(),
  key: StorageKey,
  uploadUrl: z.string().url().nullable()
});

export const CompleteBody = z.object({
  sha256: Sha256,
  filename: z.string().min(1).max(180),
  mime: z.string().min(3).max(255),
  size: z.number().int().positive(),
  key: StorageKey
});

export const CompleteResponse = z.object({
  media: MediaDTO,
  deduplicated: z.boolean()
});
