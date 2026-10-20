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
  /**
   * W20-19 (UX_TODO INS-69): register no webhooks for this connection's
   * repositories; the nightly reconcile keeps them current instead.
   */
  scheduled_sync_only: z.boolean().optional(),
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
  /** New repositories on this connection are tracked nightly (W20-17, INS-09). */
  auto_add: z.boolean(),
  /** No webhooks; updates arrive with the nightly sync (W20-19, INS-69). */
  scheduled_sync_only: z.boolean(),
});

/** PUT /connections/{id}/auto-add (W20-17, UX_TODO INS-09). */
export const autoAddBodySchema = z.object({ enabled: z.boolean() });
export const autoAddResponseSchema = z.object({ id: z.number(), auto_add: z.boolean() });

/** PUT /connections/{id}/scheduled-sync (W20-19, UX_TODO INS-69). */
export const scheduledSyncBodySchema = z.object({ enabled: z.boolean() });
export const scheduledSyncResponseSchema = z.object({
  id: z.number(),
  scheduled_sync_only: z.boolean(),
  /** Hooks deleted on the forge (turning it on) or registered (turning it off). */
  webhooks_removed: z.number(),
  webhooks_registered: z.number(),
  /** Repositories whose hook could not be removed or registered, with why. */
  webhook_failures: z.array(z.object({ repo: z.string(), error: z.string() })),
});

/** DELETE /repos/{id} — remove a repository and purge its history (W20-19, INS-09). */
export const purgeRepoBodySchema = z.object({
  /** The repository's `org/name`, typed by the admin as the confirmation. */
  confirm: z.string(),
});

export const purgeRepoResponseSchema = z.object({
  repo_id: z.number(),
  repo: z.string(),
  purged: z.literal(true),
  /** Rows deleted per table. */
  deleted: z.record(z.string(), z.number()),
  /** Multi-repository agreements, plans and CI tokens this one was taken out of. */
  narrowed: z.record(z.string(), z.number()),
  ci_tokens_revoked: z.number(),
  webhooks_removed: z.number(),
  webhook_failures: z.array(z.object({ repo: z.string(), error: z.string() })),
});

export const createConnectionResponseSchema = z.object({
  id: z.number(),
  status: z.string(),
  fingerprint: z.string(),
  scheduled_sync_only: z.boolean().optional(),
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
  /** Push hooks deleted on the forge before the credential was wiped (W20-17). */
  webhooks_removed: z.number(),
  /** Repositories whose hook could not be removed, with why. Remove these by hand. */
  webhook_failures: z.array(z.object({ repo: z.string(), error: z.string() })),
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
