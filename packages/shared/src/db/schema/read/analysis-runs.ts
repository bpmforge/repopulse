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
    // W6-05 (DATABASE.md D9). A run is one PASS, not one analysis: find,
    // then verify, then challenge. parentRunId chains them so a finding can be
    // traced to the pass that raised it AND the pass that judged it.
    passKind: text('pass_kind').notNull().default('find'),
    parentRunId: bigint('parent_run_id', { mode: 'number' }),
    chunkCount: integer('chunk_count').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    // W23-06: input tokens the provider served from its prompt cache (already
    // inside prompt_tokens). 0 when the provider reports none.
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
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
    check(
      'analysis_runs_pass_kind_check',
      sql`${t.passKind} in ('find', 'verify', 'challenge', 'synthesize', 'narrate', 'plan')`,
    ),
  ],
);
