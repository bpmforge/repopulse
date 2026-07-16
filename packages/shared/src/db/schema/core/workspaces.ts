// tenancy-exempt: this IS the tenant root (DATABASE.md §2 "Tenancy & identity").
import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // score weights (FR-INSIGHTS-2), bot-login list, stale-PR N days
  // (FR-METRICS-8), LM host list + concurrency cap, budget share.
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
