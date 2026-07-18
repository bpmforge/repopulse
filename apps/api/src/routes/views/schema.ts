import { z } from 'zod';

// FR-API-6 / DASHBOARD.md §4: the wire-level config is the filter+layout
// piece of the frontend's richer `SavedView` type (id/name/ownerId/
// sharedWithWorkspace/isHome are separate DB columns, not part of this
// blob). `layout` stays a loose array here — the precise `Widget[]` shape
// (12-col grid, WidgetType union) is DASHBOARD.md's contract for the W4
// web layer, not something this api-only ticket should pin down early.
export const viewConfigSchema = z.object({
  repo_ids: z.array(z.number().int().positive()),
  window: z.enum(['7d', '30d', '90d', '365d']),
  layout: z.array(z.record(z.string(), z.unknown())),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export const createViewBodySchema = z.object({
  name: z.string().min(1).max(200),
  config: viewConfigSchema,
  is_shared: z.boolean().optional().default(false),
});
export type CreateViewBody = z.infer<typeof createViewBodySchema>;

export const patchViewBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    config: viewConfigSchema.partial().optional(),
    is_shared: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field required' });
export type PatchViewBody = z.infer<typeof patchViewBodySchema>;

export const viewIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const shareSlugParamsSchema = z.object({ slug: z.string().min(1) });
export const listViewsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export const defaultViewBodySchema = z.object({ view_id: z.coerce.number().int().positive() });

// Owner-facing shape: everything the CRUD/share endpoints need.
export const viewResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  config: viewConfigSchema,
  is_shared: z.boolean(),
  share_slug: z.string().nullable(),
  is_default: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ViewResponse = z.infer<typeof viewResponseSchema>;

// SC-17 allowlist: GET /views/shared/{slug} is read by any workspace
// member, not just the owner. Deliberately its own schema (not a `.pick()`
// of viewResponseSchema) so adding a field to the owner shape can never
// silently widen what a shared link exposes.
export const sharedViewResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  config: viewConfigSchema,
});
export type SharedViewResponse = z.infer<typeof sharedViewResponseSchema>;

export const shareResponseSchema = z.object({ share_slug: z.string() });

export const viewListResponseSchema = z.object({
  items: z.array(viewResponseSchema),
  next_cursor: z.string().nullable(),
});
