import { bigint, check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { identities } from '../core/identities.js';
import { pullRequests } from './pull-requests.js';

// When a reviewer was asked (W20-24, UX_TODO DSH-41).
//
// The review queue measured "waiting" from when the pull request was OPENED,
// so a reviewer added on day nine was overdue the moment they were asked.
// `timeline` rows come from the forge's issue events (exact); `observed` rows
// are a request that first appeared on a later pull-request listing, stamped
// with that listing's updated time — no earlier than the request, and said so.
// The reviewer is an identity (a login), never a forge user id.
export const prReviewRequests = pgTable(
  'pr_review_requests',
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
    reviewerIdentityId: bigint('reviewer_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
  },
  (t) => [
    unique('pr_review_requests_pr_reviewer_at_key').on(
      t.pullRequestId,
      t.reviewerIdentityId,
      t.requestedAt,
    ),
    index('pr_review_requests_workspace_reviewer_idx').on(
      t.workspaceId,
      t.reviewerIdentityId,
      t.requestedAt,
    ),
    check('pr_review_requests_source_check', sql`${t.source} in ('timeline', 'observed')`),
  ],
);
