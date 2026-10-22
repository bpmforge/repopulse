import { bigint, index, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';

// One file's hotspot score over time (W20-24, UX_TODO DSH-37).
//
// Written for files that carry an intent: once when the intent is saved (the
// baseline) and by every snapshot run after. M2's per-file list keeps only a
// repository's top files, so a file that cooled off simply vanished from it
// and "has the hotspot improved since we said we would refactor it?" had no
// answer. Append-only, like metric_snapshots.
export const fileHotspotScores = pgTable(
  'file_hotspot_scores',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    path: text('path').notNull(),
    /** The window the score is computed over (the file page's, '30d'). */
    window: text('window').notNull(),
    score: numeric('score', { precision: 12, scale: 6 }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('file_hotspot_scores_workspace_repo_path_idx').on(
      t.workspaceId,
      t.repoId,
      t.path,
      t.computedAt,
    ),
  ],
);
