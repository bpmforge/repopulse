import { z } from 'zod';

// API_DESIGN.md §2 connections. The credential is accepted but NEVER echoed
// back (FR-AUTH-5) — responses carry only fingerprint/last4/status.

export const createConnectionBodySchema = z.object({
  provider: z.enum(['github', 'gitea', 'gitlab']).default('github'),
  auth_kind: z.enum(['pat', 'app']),
  credential: z.string().min(1),
  installation_id: z.string().optional(),
  /**
   * This connection's forge base URL (W14-02).
   *
   * Required for Gitea, which is self-hosted and has no default host worth
   * guessing. Optional elsewhere: absent means gitlab.com for GitLab, and
   * api.github.com (or whatever FORGE_BASE_URL says for a GitHub Enterprise
   * install) for GitHub. Resolved and STORED at creation (W20-07, INS-73).
   */
  base_url: z.string().url().optional(),
});

export const connectionSummarySchema = z.object({
  id: z.number(),
  provider: z.string(),
  auth_kind: z.string(),
  fingerprint: z.string(),
  last4: z.string(),
  status: z.string(),
  repo_count: z.number(),
  /** Null on a connection created before W14-02 and not yet resolved. */
  base_url: z.string().nullable(),
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

export const availableRepoWithStateSchema = availableRepoSchema.extend({
  /** Already tracked on this connection (W20-07, UX_TODO INS-10). */
  tracked: z.boolean(),
  /** The tracked repo's sync status (`live`, `paused`, …); null when untracked. */
  sync_status: z.string().nullable(),
});

export const availableReposResponseSchema = z.object({
  items: z.array(availableRepoWithStateSchema),
  /** Every page, counted (W20-07, UX_TODO INS-52). */
  total: z.number(),
  /** True when the forge kept paging past the runaway guard. */
  truncated: z.boolean(),
});

/** PATCH /connections/{id} — replace the credential (W20-07, UX_TODO INS-08). */
export const replaceCredentialBodySchema = z.object({
  credential: z.string().min(1),
});

export const replaceCredentialResponseSchema = z.object({
  id: z.number(),
  status: z.string(),
  fingerprint: z.string(),
});

/** DELETE /connections/{id} — what happened to the repos it tracked. */
export const removeConnectionResponseSchema = z.object({
  id: z.number(),
  /** `deleted` (it tracked nothing) or `disconnected` (history kept, repos paused). */
  outcome: z.enum(['deleted', 'disconnected']),
  paused_repos: z.number(),
});

/** PUT /repos/{id}/tracking — pause or resume one repo (W20-07, UX_TODO INS-09). */
export const repoTrackingBodySchema = z.object({ paused: z.boolean() });

export const repoTrackingResponseSchema = z.object({
  repo_id: z.number(),
  sync_status: z.string(),
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
  /**
   * INS-29: `org/name` of each newly tracked repo whose webhook the forge
   * refused. They still backfill; they just get no live updates.
   */
  webhook_failed: z.array(z.string()).optional(),
});

export const connectionIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
