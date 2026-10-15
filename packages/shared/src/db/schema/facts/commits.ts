import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { identities } from '../core/identities.js';

export const commits = pgTable(
  'commits',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    sha: text('sha').notNull(),
    authorIdentityId: bigint('author_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    committerIdentityId: bigint('committer_identity_id', { mode: 'number' })
      .notNull()
      .references(() => identities.id),
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    messageHead: text('message_head').notNull(),
    // W18-20 (migration 0035): the git trailers of the commit message's last
    // paragraph ("Co-authored-by: Claude <noreply@anthropic.com>"), one
    // "Key: value" string each. Stored RAW rather than as a verdict so an
    // admin's edit to the AI-authorship pattern list re-classifies history on
    // the next read instead of needing a re-ingest. NULL = ingested before
    // trailers were captured — unknown, which is not the same as "had none".
    trailers: text('trailers').array(),
    isRevertHeuristic: boolean('is_revert_heuristic').notNull(),
    // >1 parent ⇒ merge commit. Set at ingest from the forge parent list
    // (W2-03 upsert); METRICS.md §0 excludes merges from churn/hotspots/
    // ownership (M1/M2/M3). Added W3-10: the metric functions need it and the
    // backfill already computed the parent count — it was only dropped for lack
    // of a column. Default false so existing rows are non-merge.
    isMerge: boolean('is_merge').notNull().default(false),
    // Nullable: filled by the churn path chosen per research §8
    // (stats-first, per-commit fallback).
    additions: integer('additions'),
    deletions: integer('deletions'),
    filesCount: integer('files_count'),
    // 'unavailable' (W17-38): the forge permanently refused the detail fetch
    // (404/422 on a vanished SHA, 403 on scope). Nothing was measured, so it is
    // not 'detail' — a churn metric must never read it as zero — but it leaves
    // the enrichment work-list, or one refused commit would hold the repo in
    // backfilling forever. The reason is on sync_cursors('commit_files').
    statsSource: text('stats_source'),
  },
  (t) => [
    index('commits_workspace_id_idx').on(t.workspaceId),
    unique('commits_repo_sha_key').on(t.repoId, t.sha),
    // Churn by author (DATABASE.md §3 hot-path index)
    index('commits_workspace_repo_author_authored_idx').on(
      t.workspaceId,
      t.repoId,
      t.authorIdentityId,
      t.authoredAt,
    ),
    check(
      'commits_stats_source_check',
      sql`${t.statsSource} is null or ${t.statsSource} in ('detail', 'stats_api', 'graphql', 'unavailable')`,
    ),
  ],
);
