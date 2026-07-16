import { bigint, index, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';

// Append-only time series (ADR-7, FR-METRICS-13/14). Never updated, never
// deleted inside retention (>=400 days). Table/column names reconciled with
// docs/design/METRICS.md §2 (which used metric_snapshot/metric_id — fixed
// there to match this doc, the self-consistent source across §2 and §3).
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    // NULL = org-level rollup row.
    repoId: bigint('repo_id', { mode: 'number' }).references(() => repos.id),
    metricKey: text('metric_key').notNull(),
    window: text('window').notNull(),
    dims: jsonb('dims').$type<Record<string, unknown>>().notNull().default({}),
    value: numeric('value', { precision: 18, scale: 6 }).notNull(),
    numerator: numeric('numerator', { precision: 18, scale: 6 }),
    denominator: numeric('denominator', { precision: 18, scale: 6 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Org rollup tiles + trends / Repo detail metrics (DATABASE.md §3)
    index('metric_snapshots_workspace_repo_key_window_computed_idx').on(
      t.workspaceId,
      t.repoId,
      t.metricKey,
      t.window,
      t.computedAt.desc(),
    ),
    // Org rollups indexed via partial index WHERE repo_id IS NULL (DATABASE.md §3)
    index('metric_snapshots_org_rollup_idx')
      .on(t.workspaceId, t.metricKey, t.window, t.computedAt.desc())
      .where(sql`${t.repoId} is null`),
  ],
);
