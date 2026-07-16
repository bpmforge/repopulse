import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

// DLQ ledger (NFR-11). DATABASE.md §2 doesn't list an explicit `id` column
// (same as webhook_delivery) — added a surrogate bigint PK for consistency
// with the rest of the schema.
export const jobFailure = pgTable(
  'job_failure',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    queue: text('queue').notNull(),
    jobId: text('job_id').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    error: text('error').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
  },
  (t) => [index('job_failure_workspace_id_idx').on(t.workspaceId)],
);
