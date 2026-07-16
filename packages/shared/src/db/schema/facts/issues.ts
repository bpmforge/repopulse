import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { identities } from '../core/identities.js';

export const issues = pgTable(
  'issues',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    authorIdentityId: bigint('author_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    // No enum values enumerated in DATABASE.md for this field (unlike
    // pull_requests.state) — left as plain text, not CHECK-constrained.
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    reopenedCount: smallint('reopened_count').notNull().default(0),
    // Always excluded from issue metrics (FR-METRICS-10).
    isPullRequest: boolean('is_pull_request').notNull(),
  },
  (t) => [
    unique('issues_repo_number_key').on(t.repoId, t.number),
    index('issues_workspace_id_idx').on(t.workspaceId),
  ],
);
