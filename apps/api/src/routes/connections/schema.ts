import { z } from 'zod';

// API_DESIGN.md §2 connections. The credential is accepted but NEVER echoed
// back (FR-AUTH-5) — responses carry only fingerprint/last4/status.

export const createConnectionBodySchema = z.object({
  provider: z.enum(['github', 'gitea']).default('github'),
  auth_kind: z.enum(['pat', 'app']),
  credential: z.string().min(1),
  installation_id: z.string().optional(),
});

export const connectionSummarySchema = z.object({
  id: z.number(),
  provider: z.string(),
  auth_kind: z.string(),
  fingerprint: z.string(),
  last4: z.string(),
  status: z.string(),
  repo_count: z.number(),
});

export const createConnectionResponseSchema = z.object({
  id: z.number(),
  status: z.string(),
  fingerprint: z.string(),
});

export const connectionListResponseSchema = z.object({
  items: z.array(connectionSummarySchema),
});

export const availableRepoSchema = z.object({
  forge_repo_id: z.string(),
  org: z.string(),
  name: z.string(),
  is_private: z.boolean(),
  is_archived: z.boolean(),
});

export const availableReposResponseSchema = z.object({
  items: z.array(availableRepoSchema),
});

export const selectReposBodySchema = z
  .object({
    repo_forge_ids: z.array(z.string()).optional(),
    all_with_auto_add: z.boolean().optional(),
  })
  .refine((b) => b.all_with_auto_add === true || (b.repo_forge_ids?.length ?? 0) > 0, {
    message: 'provide repo_forge_ids or all_with_auto_add',
  });

export const selectReposResponseSchema = z.object({
  repo_ids: z.array(z.number()),
});

export const connectionIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
