import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import * as schema from './index.js';

describe('core schema (DATABASE.md §2 Tenancy & identity / Sync machinery)', () => {
  it('exports exactly the ten documented core tables', () => {
    const tableNames = [
      schema.workspaces,
      schema.users,
      schema.workspaceMembers,
      schema.forgeConnections,
      schema.identities,
      schema.repos,
      schema.syncCursors,
      schema.forgeEtag,
      schema.webhookDelivery,
      schema.jobFailure,
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      'workspaces',
      'users',
      'workspace_members',
      'forge_connections',
      'identities',
      'repos',
      'sync_cursors',
      'forge_etag',
      'webhook_delivery',
      'job_failure',
    ]);
  });
});
