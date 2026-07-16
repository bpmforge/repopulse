import { bigint, check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { commits } from './commits.js';

// Churn fact granularity = per file per commit (FR-METRICS-1/2/3). No patch
// text stored — diff text is fetched on demand for LLM tiers, never
// warehoused (ADR-1). Biggest table in the schema.
export const commitFiles = pgTable(
  'commit_files',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    commitId: bigint('commit_id', { mode: 'number' })
      .notNull()
      .references(() => commits.id),
    path: text('path').notNull(),
    additions: integer('additions').notNull(),
    deletions: integer('deletions').notNull(),
    status: text('status').notNull(),
    previousPath: text('previous_path'),
  },
  (t) => [
    primaryKey({ columns: [t.commitId, t.path] }),
    index('commit_files_workspace_id_idx').on(t.workspaceId),
    // File hotspot ranking (DATABASE.md §3 hot-path index)
    index('commit_files_workspace_repo_path_commit_idx').on(
      t.workspaceId,
      t.repoId,
      t.path,
      t.commitId,
    ),
    check(
      'commit_files_status_check',
      sql`${t.status} in ('added', 'modified', 'removed', 'renamed')`,
    ),
  ],
);
