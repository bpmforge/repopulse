import { bigint, boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';

export const savedViews = pgTable(
  'saved_views',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    // CASCADE (W16-59), and NOT set null, because ownership here gates
    // visibility AND editing: the list query filters by owner and every
    // mutation is owner-only. A null owner would leave a view that appears in
    // nobody's list, that nobody can edit or delete, and that is readable only
    // if it happened to be shared — worse than removing it. A view is a layout,
    // and the templates that made it are still there.
    ownerUserId: bigint('owner_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // repo filter, window, tile layout
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    shareSlug: text('share_slug').unique(),
    isDefaultForOwner: boolean('is_default_for_owner').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('saved_views_workspace_id_idx').on(t.workspaceId)],
);
