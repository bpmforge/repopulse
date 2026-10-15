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
import { pullRequests } from './pull-requests.js';

// Inline review comments (W18-23, METRICS.md §5). Only the diff ANCHORS are
// kept — never the body: the AI-reviewer metrics count and locate comments,
// and a warehoused copy of review prose is data nobody asked us to hold.
//
// `current_line` null means the forge no longer anchors the comment on the
// PR's head diff because a later push rewrote the lines it was written on —
// the signal METRICS.md §5 defines "followed by a code change" over.
//
// When the rows were fetched lives on the PR (review_comments_observed_at):
// the anchor keeps moving while the PR is open, so §5 reads a row as final
// only when that fetch came after the PR closed.
export const prReviewComments = pgTable(
  'pr_review_comments',
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
    forgeCommentId: text('forge_comment_id').notNull(),
    forgeReviewId: text('forge_review_id'),
    authorIdentityId: bigint('author_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    path: text('path').notNull(),
    subjectType: text('subject_type').notNull(),
    isReply: boolean('is_reply').notNull(),
    originalStartLine: integer('original_start_line'),
    originalLine: integer('original_line'),
    currentLine: integer('current_line'),
    originalCommitSha: text('original_commit_sha').notNull(),
    commitSha: text('commit_sha').notNull(),
  },
  (t) => [
    unique('pr_review_comments_pull_request_forge_comment_key').on(
      t.pullRequestId,
      t.forgeCommentId,
    ),
    index('pr_review_comments_workspace_repo_created_idx').on(t.workspaceId, t.repoId, t.createdAt),
    check('pr_review_comments_subject_type_check', sql`${t.subjectType} in ('line', 'file')`),
  ],
);
