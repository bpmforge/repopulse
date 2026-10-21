import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';
import { findings } from './findings.js';
import { scanRuns } from '../security/index.js';

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
    // NULL ALREADY MEANS SOMETHING HERE (W16-59): the API reports
    // `automatic: actor === null` — a null actor is the analysis pass acting by
    // itself. So SET NULL alone would silently reclassify a departed person's
    // triage decisions as automatic, which is a worse lie than refusing the
    // delete. The login is denormalised beside the id so the record survives
    // the account: actor null AND actor_login null is automatic; actor null
    // with a login is a person whose account has since been removed.
    actor: bigint('actor', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    actorLogin: text('actor_login'),
    reason: text('reason'),
    /**
     * W20-21 (UX_TODO FND-51): the scan behind an automatic change - the one
     * that stopped seeing the finding (resolved) or saw it again (reopened).
     * Null for a person's change and for older rows.
     */
    scanRunId: bigint('scan_run_id', { mode: 'number' }).references(() => scanRuns.id, {
      onDelete: 'set null',
    }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finding_events_workspace_id_idx').on(t.workspaceId),
    index('finding_events_finding_id_idx').on(t.findingId),
  ],
);
