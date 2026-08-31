import { bigint, check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { users } from './users.js';

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    // CASCADE (W16-59): a membership without a member is not a row worth
    // keeping. This is the one place where deleting the person really does mean
    // deleting the record.
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // DATABASE.md §5: text + CHECK, not a pg enum (likely to grow).
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_workspace_id_idx').on(t.workspaceId),
    check('workspace_members_role_check', sql`${t.role} in ('admin', 'member')`),
  ],
);
