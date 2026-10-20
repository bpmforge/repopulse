import { bigint, check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';

// Immutable snapshots (FR-REPORTS-1/7). *_uri point at object/file storage
// (local volume v1); DB stores pointers, not blobs.
export const reports = pgTable(
  'reports',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(),
    // repo_ids[], window, pinned_at
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    htmlUri: text('html_uri'),
    pdfUri: text('pdf_uri'),
    // The stored ReportData (REPORTS.md §3). It is what the print route
    // renders from and what a regeneration re-renders, so a report can be
    // reproduced byte-for-byte without re-reading the warehouse — which is
    // the whole point of pinning snapshotAt in the first place.
    jsonUri: text('json_uri'),
    // Why a generation failed, kept ON the row: a failed report that says
    // nothing sends its owner to the worker logs, and REPORTS.md §3 lists it.
    error: text('error'),
    // SET NULL (W16-59). A report is evidence in a conversation about
    // someone's team; removing an account must not remove the report.
    generatedBy: bigint('generated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    // Set once, when the report is first asked for (W20-19, UX_TODO ADM-61).
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    // When the row was last queued: equal to generated_at until a Retry moves
    // it. The stalled-worker hint measures from here; History sorts and dates
    // by generated_at, so a retried report keeps its place and its date
    // (W20-19, UX_TODO ADM-61, migration 0052).
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reports_workspace_id_idx').on(t.workspaceId),
    check(
      'reports_type_check',
      sql`${t.type} in ('repo_health', 'org_exec', 'security_posture', 'delivery_dora')`,
    ),
    check('reports_status_check', sql`${t.status} in ('queued', 'running', 'ready', 'failed')`),
  ],
);
