import {
  bigint,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { pullRequests } from './pull-requests.js';

export const checkRuns = pgTable(
  'check_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    forgeRunId: text('forge_run_id').notNull(),
    kind: text('kind').notNull(),
    workflowName: text('workflow_name'),
    headSha: text('head_sha').notNull(),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    // Powers flakiness (fail->pass same head SHA, FR-METRICS-9).
    runAttempt: smallint('run_attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
  },
  (t) => [
    unique('check_runs_repo_kind_forge_run_attempt_key').on(
      t.repoId,
      t.kind,
      t.forgeRunId,
      t.runAttempt,
    ),
    // CI pass rate (DATABASE.md §3 hot-path index)
    index('check_runs_workspace_repo_workflow_completed_idx').on(
      t.workspaceId,
      t.repoId,
      t.workflowName,
      t.completedAt,
    ),
    check('check_runs_kind_check', sql`${t.kind} in ('check_run', 'workflow_run')`),
  ],
);
