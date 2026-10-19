import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';

// W20-10 (UX_TODO X-04). Every `auditLog()` call used to end as an `audit:`
// line in the container log and nowhere else, so an admin could not see in the
// app who changed a rule, a setting or an AI opt-in, or when. This is the
// persisted copy behind Settings → Audit log.
//
// Workspace-scoped like every tenant table (Law 5). Events written before a
// workspace is known (a failed sign-in) stay in the log only — they belong to
// no tenant, and inventing one would put them on the wrong screen.
//
// The actor is a plain id plus the login denormalised beside it, NOT a foreign
// key: removing a member deletes their user row, and the audit entry is the one
// place their name has to survive (same reasoning as egress_audit, W16-59).
// `detail` holds the event's own fields; auditLog's contract already forbids
// token or credential material in them.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      // CASCADE: the log belongs to its workspace and goes with it.
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actorUserId: bigint('actor_user_id', { mode: 'number' }),
    actorLogin: text('actor_login'),
    ip: text('ip'),
    ua: text('ua'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_workspace_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('audit_events_workspace_event_idx').on(t.workspaceId, t.event),
  ],
);
