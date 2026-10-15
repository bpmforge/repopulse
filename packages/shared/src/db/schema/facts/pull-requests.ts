import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { identities } from '../core/identities.js';

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    forgePrId: text('forge_pr_id').notNull(),
    title: text('title').notNull(),
    authorIdentityId: bigint('author_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    state: text('state').notNull(),
    isDraft: boolean('is_draft').notNull(),
    isBot: boolean('is_bot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedByIdentityId: bigint('merged_by_identity_id', { mode: 'number' }).references(
      () => identities.id,
    ),
    baseRef: text('base_ref').notNull(),
    headSha: text('head_sha').notNull(),
    // W18-20 (migration 0035): the source branch, for agent branch prefixes
    // (claude/, copilot/, devin/...). NULL = unknown (ingested before 0035, or
    // the forge did not say) — never matched by a prefix rule.
    headRef: text('head_ref'),
    // Set once the enrichment lane has fetched this PR's reviews and check
    // runs. A per-PR marker rather than a repo-level high-watermark: enrich
    // jobs run concurrently and complete out of order, so a watermark could
    // advance past PRs that never ran and report enrichment drained — which
    // would flip the repo to `live` with reviews missing. NULL = not yet
    // enriched, which is also the honest answer for a PR that genuinely has
    // zero reviews and zero checks (counting child rows cannot tell those
    // apart, and would leave such a repo backfilling forever).
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    additions: integer('additions').notNull(),
    deletions: integer('deletions').notNull(),
    changedFiles: integer('changed_files').notNull(),
    // Ingest-maintained denormalizations so cycle-time (FR-METRICS-4) and
    // staleness (FR-METRICS-8) are index scans, not per-request aggregation.
    firstReviewAt: timestamp('first_review_at', { withTimezone: true }),
    firstApprovalAt: timestamp('first_approval_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    lastActivityKind: text('last_activity_kind'),
  },
  (t) => [
    unique('pull_requests_repo_number_key').on(t.repoId, t.number),
    // PR list w/ cycle-time sort/filter (DATABASE.md §3 hot-path indexes)
    index('pull_requests_workspace_repo_state_merged_idx').on(
      t.workspaceId,
      t.repoId,
      t.state,
      t.mergedAt,
    ),
    index('pull_requests_workspace_repo_last_activity_idx').on(
      t.workspaceId,
      t.repoId,
      t.lastActivityAt,
    ),
    index('pull_requests_workspace_author_state_idx').on(
      t.workspaceId,
      t.authorIdentityId,
      t.state,
    ),
    check('pull_requests_state_check', sql`${t.state} in ('open', 'closed', 'merged')`),
  ],
);
