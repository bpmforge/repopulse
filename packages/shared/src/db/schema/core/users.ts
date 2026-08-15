// tenancy-exempt: global — a user may join many workspaces (DATABASE.md §2).
import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  forgeUserId: text('forge_user_id').notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  // W4-10 (UX_SPEC §6, D9/R-A2). NULL means "not asked yet", which is what
  // triggers the picker — distinct from any persona value, so a user who picks
  // one is never asked again and a user who somehow clears it is.
  persona: text('persona'),
  // Per-user preferences (onboarding checklist dismissal today). Deliberately
  // on `users` and not `workspaces.settings`: the checklist has a member
  // variant, and workspace-scoped state would let one member's dismissal hide
  // it for everyone. R-A1's "no new tables" is honoured — this is a column.
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
