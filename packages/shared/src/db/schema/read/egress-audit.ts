import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { users } from '../core/users.js';
import { pullRequests } from '../facts/pull-requests.js';
import { analysisRuns } from './analysis-runs.js';

// Append-only, Tier-3 only (NFR-9). No content stored — digest only.
// Admin-queryable, never deleted. SC-15: INSERT-only grant for the app DB
// role applied in migration 0002 (drizzle can't generate GRANT/CREATE ROLE
// from schema — see packages/shared/drizzle/0002_egress_audit_grants.sql).
export const egressAudit = pgTable(
  'egress_audit',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    analysisRunId: bigint('analysis_run_id', { mode: 'number' })
      .notNull()
      .references(() => analysisRuns.id),
    // The audit row is the point (W16-59). SET NULL on its own would leave a
    // record that code left the network and NOT who sent it — the single field
    // this table exists to hold. The login is denormalised beside the id, so
    // deleting an account cannot erase the fact that they sent it.
    initiatorUserId: bigint('initiator_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    initiatorLogin: text('initiator_login'),
    modelId: text('model_id').notNull(),
    bytesSent: integer('bytes_sent').notNull(),
    tokensSent: integer('tokens_sent').notNull(),
    tokensReceived: integer('tokens_received').notNull(),
    contentSha256: text('content_sha256').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('egress_audit_workspace_id_idx').on(t.workspaceId)],
);
