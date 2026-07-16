import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { forgeConnections } from './forge-connections.js';

// Replay/dedup ledger (SC-4, FR-INGEST-5/6). DATABASE.md §2 lists
// `delivery_id text unique` without an explicit `id` column (unlike every
// other entity table) — added a surrogate bigint PK here for consistency
// with the rest of the schema; delivery_id keeps its documented uniqueness.
export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    connectionId: bigint('connection_id', { mode: 'number' })
      .notNull()
      .references(() => forgeConnections.id),
    deliveryId: text('delivery_id').notNull().unique(),
    event: text('event').notNull(),
    action: text('action'),
    repoFullName: text('repo_full_name').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    payloadDigest: text('payload_digest').notNull(),
  },
  (t) => [index('webhook_delivery_workspace_id_idx').on(t.workspaceId)],
);
