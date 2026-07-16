import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { pullRequests } from '../facts/pull-requests.js';

// Base shape only (FR-ANALYSIS-4/7) — the D9 pass_kind/parent_run_id delta
// (find->verify->challenge chain) is a later-wave additive migration, not
// part of W1-02.
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    tier: smallint('tier').notNull(),
    dimension: text('dimension').notNull(),
    checklistVersion: text('checklist_version').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    // Tier 3 only.
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('analysis_runs_workspace_id_idx').on(t.workspaceId),
    check('analysis_runs_tier_check', sql`${t.tier} in (2, 3)`),
    check(
      'analysis_runs_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')`,
    ),
  ],
);
