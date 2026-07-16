import { z } from 'zod';

// Shared filter/pagination params on list endpoints (API_DESIGN.md §1).
// Not wired into any concrete route yet — no list endpoints exist until a
// later wave's feature tickets — but exported so they compose the same way
// everywhere once those tickets land, per §1's "shared ... fragment" intent.
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const listFilterSchema = z.object({
  window: z.enum(['7d', '30d', '90d', '365d']).optional().default('30d'),
  repo_ids: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',').map(Number) : undefined)),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const listQuerySchema = cursorPaginationSchema.merge(listFilterSchema);

export function listResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    next_cursor: z.string().nullable(),
  });
}
