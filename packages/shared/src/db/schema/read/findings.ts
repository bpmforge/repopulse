import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { users } from '../core/users.js';
import { pullRequests } from '../facts/pull-requests.js';
import { analysisRuns } from './analysis-runs.js';

// Base shape only (ANALYSIS_TIERS.md §4/§5) — the W8/D9/D10/D11/D12/D13
// delta columns (scanner_key, verify_status, risk_factors, reachability,
// experimental, etc.) are later-wave additive migrations, not part of
// W1-02. file/line_start/line_end are NOT NULL here; the W8 migration
// makes them nullable for repo-level scanner findings (DATABASE.md §2).
export const findings = pgTable(
  'findings',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    analysisRunId: bigint('analysis_run_id', { mode: 'number' })
      .notNull()
      .references(() => analysisRuns.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    dimension: text('dimension').notNull(),
    // 1-5, 5=critical ... 1=info (ANALYSIS_TIERS.md §4 canonical numeric scale).
    severity: smallint('severity').notNull(),
    confidence: smallint('confidence').notNull(),
    title: text('title').notNull(),
    file: text('file').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    evidence: text('evidence').notNull(),
    recommendation: text('recommendation').notNull(),
    tier: smallint('tier').notNull(),
    // sha256(dimension + '\0' + file + '\0' + normalize(evidence_quote)) +
    // line-bucket tiebreak (ANALYSIS_TIERS.md §5).
    dedupKey: text('dedup_key').notNull(),
    status: text('status').notNull(),
    dismissReason: text('dismiss_reason'),
    statusChangedBy: bigint('status_changed_by', { mode: 'number' }).references(() => users.id),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
  },
  (t) => [
    unique('findings_workspace_repo_dedup_key').on(t.workspaceId, t.repoId, t.dedupKey),
    // Findings filters (DATABASE.md §3 hot-path index)
    index('findings_workspace_repo_dimension_severity_status_idx').on(
      t.workspaceId,
      t.repoId,
      t.dimension,
      t.severity,
      t.status,
    ),
    check(
      'findings_dimension_check',
      sql`${t.dimension} in ('code_health', 'security', 'performance', 'test_coverage')`,
    ),
    check('findings_severity_check', sql`${t.severity} between 1 and 5`),
    check('findings_confidence_check', sql`${t.confidence} between 1 and 5`),
    check(
      'findings_status_check',
      sql`${t.status} in ('open', 'confirmed', 'dismissed', 'resolved', 'wont_fix')`,
    ),
  ],
);
