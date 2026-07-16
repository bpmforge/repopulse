import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { forgeConnections } from './forge-connections.js';

// ETag store (FR-FORGE-4, ADR-1). Not workspace-critical (derivable), but
// carries workspace_id anyway for uniform RLS (DATABASE.md §2). Prunable
// cache — safe to truncate.
export const forgeEtag = pgTable(
  'forge_etag',
  {
    connectionId: bigint('connection_id', { mode: 'number' })
      .notNull()
      .references(() => forgeConnections.id),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    installationId: text('installation_id'),
    // method+path+params hash
    endpointKey: text('endpoint_key').notNull(),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastStatus: smallint('last_status'),
    bodyDigest: text('body_digest'),
    cachedBody: jsonb('cached_body').$type<unknown>(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.endpointKey] }),
    index('forge_etag_workspace_id_idx').on(t.workspaceId),
  ],
);
