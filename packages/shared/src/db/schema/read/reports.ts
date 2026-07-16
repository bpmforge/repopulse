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
    generatedBy: bigint('generated_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
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
