import { bigint, check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { identities } from '../core/identities.js';
import { pullRequests } from './pull-requests.js';

export const prReviews = pgTable(
  'pr_reviews',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' })
      .notNull()
      .references(() => pullRequests.id),
    forgeReviewId: text('forge_review_id').notNull(),
    reviewerIdentityId: bigint('reviewer_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    state: text('state').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('pr_reviews_pull_request_forge_review_key').on(t.pullRequestId, t.forgeReviewId),
    // Review-load widget (DATABASE.md §3 hot-path index)
    index('pr_reviews_workspace_reviewer_submitted_idx').on(
      t.workspaceId,
      t.reviewerIdentityId,
      t.submittedAt,
    ),
    check(
      'pr_reviews_state_check',
      sql`${t.state} in ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED')`,
    ),
  ],
);
