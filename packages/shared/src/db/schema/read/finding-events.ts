import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';
import { findings } from './findings.js';

// Status history (DATABASE.md §2 calls this finding_events, not
// finding_status_history — see plan.json W1-02 notes for the naming
// reconciliation). DATABASE.md's terse column list omits both `id` and
// `workspace_id`; added both for consistency with the rest of the schema
// and Law 5 tenancy (same treatment forge_etag's doc entry called out
// explicitly: "carries workspace_id anyway").
export const findingEvents = pgTable(
  'finding_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    findingId: bigint('finding_id', { mode: 'number' })
      .notNull()
      .references(() => findings.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: bigint('actor', { mode: 'number' }).references(() => users.id),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finding_events_workspace_id_idx').on(t.workspaceId),
    index('finding_events_finding_id_idx').on(t.findingId),
  ],
);
