import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { users } from './users.js';

export const identities = pgTable(
  'identities',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    // Same provider domain as forge_connections.provider (DATABASE.md §5:
    // text + CHECK, not a pg enum).
    provider: text('provider').notNull(),
    forgeLogin: text('forge_login').notNull(),
    forgeUserId: text('forge_user_id'),
    displayName: text('display_name').notNull(),
    // SET NULL (W16-59). An identity is a COMMITTER and a user is a LOGIN:
    // the commits stay, the claim on them goes.
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    isBot: boolean('is_bot').notNull().default(false),
    // Self-FK: merges are non-destructive/reversible (DATABASE.md §2) —
    // queries resolve through COALESCE(merged_into_id, id).
    mergedIntoId: bigint('merged_into_id', { mode: 'number' }).references(
      (): AnyPgColumn => identities.id,
    ),
  },
  (t) => [
    index('identities_workspace_id_idx').on(t.workspaceId),
    unique('identities_workspace_provider_login_key').on(t.workspaceId, t.provider, t.forgeLogin),
    check('identities_provider_check', sql`${t.provider} in ('github', 'gitea', 'gitlab')`),
  ],
);
