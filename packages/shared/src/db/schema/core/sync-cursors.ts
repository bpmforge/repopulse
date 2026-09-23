import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { repos } from './repos.js';

export const syncCursors = pgTable(
  'sync_cursors',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    // DATABASE.md §5: text + CHECK, not a pg enum (likely to grow).
    entityType: text('entity_type').notNull(),
    // updated_at watermark | page cursor | delivery id — null before first sync.
    cursorValue: text('cursor_value'),
    backfillDone: boolean('backfill_done').notNull().default(false),
    // W17-35: why this entity holds no data, when the forge refused it (e.g.
    // "HTTP 403 — token lacks read:issue"). Null when the last fetch succeeded.
    // backfill_done alone could not tell "finished" from "never allowed to look".
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.entityType] }),
    index('sync_cursors_workspace_id_idx').on(t.workspaceId),
    check(
      'sync_cursors_entity_type_check',
      sql`${t.entityType} in ('commits', 'prs', 'reviews', 'pr_files', 'checks', 'issues', 'releases', 'deployments', 'workflow_runs')`,
    ),
  ],
);
