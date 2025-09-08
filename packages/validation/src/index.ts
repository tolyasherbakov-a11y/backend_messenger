import { z } from 'zod';

export const Id = z.string().min(1).max(128);
export const Handle = z.string().min(3).max(32).regex(/^[a-z0-9_]+$/);

export const Cursor = z.string().brand<'Cursor'>();

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional()
});

export type Infer<T extends z.ZodTypeAny> = z.infer<T>;
export { z };
