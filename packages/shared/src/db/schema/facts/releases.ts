import { bigint, boolean, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';

export const releases = pgTable(
  'releases',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    forgeReleaseId: text('forge_release_id').notNull(),
    tag: text('tag').notNull(),
    name: text('name'),
    isDraft: boolean('is_draft').notNull(),
    isPrerelease: boolean('is_prerelease').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    unique('releases_repo_forge_release_key').on(t.repoId, t.forgeReleaseId),
    index('releases_workspace_id_idx').on(t.workspaceId),
  ],
);
