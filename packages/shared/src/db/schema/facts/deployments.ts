import { bigint, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';

export const deployments = pgTable(
  'deployments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    forgeDeploymentId: text('forge_deployment_id').notNull(),
    environment: text('environment').notNull(),
    sha: text('sha').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    latestStatus: text('latest_status').notNull(),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('deployments_repo_forge_deployment_key').on(t.repoId, t.forgeDeploymentId),
    index('deployments_workspace_id_idx').on(t.workspaceId),
  ],
);
