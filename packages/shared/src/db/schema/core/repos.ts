import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { forgeConnections } from './forge-connections.js';

export const repos = pgTable(
  'repos',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    connectionId: bigint('connection_id', { mode: 'number' })
      .notNull()
      .references(() => forgeConnections.id),
    forgeRepoId: text('forge_repo_id').notNull(),
    org: text('org').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    isPrivate: boolean('is_private').notNull(),
    isArchived: boolean('is_archived').notNull(),
    // DATABASE.md §5: text + CHECK, not a pg enum (likely to grow).
    syncStatus: text('sync_status').notNull(),
    // Not specified in DATABASE.md; 0 is the natural starting value for a
    // freshly connected, not-yet-backfilled repo.
    backfillPct: smallint('backfill_pct').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    // No default stated in DATABASE.md (unlike tier3_opt_in's explicit
    // `default false`) — left required at insert rather than guessing.
    tier2Auto: boolean('tier2_auto').notNull(),
    tier3OptIn: boolean('tier3_opt_in').notNull().default(false),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
  },
  (t) => [
    index('repos_workspace_id_idx').on(t.workspaceId),
    unique('repos_workspace_connection_forge_repo_key').on(
      t.workspaceId,
      t.connectionId,
      t.forgeRepoId,
    ),
    check(
      'repos_sync_status_check',
      sql`${t.syncStatus} in ('pending_backfill', 'backfilling', 'live', 'error', 'paused_budget', 'paused')`,
    ),
  ],
);
