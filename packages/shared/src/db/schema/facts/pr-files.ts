import { bigint, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { pullRequests } from './pull-requests.js';

// From GraphQL backfill (research §6); feeds PR-size (FR-METRICS-7) and
// file<->PR drill-down. No patch text.
export const prFiles = pgTable(
  'pr_files',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' })
      .notNull()
      .references(() => pullRequests.id),
    path: text('path').notNull(),
    additions: integer('additions').notNull(),
    deletions: integer('deletions').notNull(),
    changeType: text('change_type').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pullRequestId, t.path] }),
    index('pr_files_workspace_id_idx').on(t.workspaceId),
  ],
);
