import { and, eq, ne, or, isNull, sql } from 'drizzle-orm';
import { facts } from '@repopulse/shared';
import type { DbOrTx } from './db.js';

// Which commits still need file churn (W12-05).
//
// One query serving two purposes deliberately: it is the PRODUCER's work list
// (which enrich jobs to enqueue) and it is the definition of "the enrichment
// queue is drained for this repo" that INGESTION §2's `enrichment --> live`
// transition needs. There is no per-entity `backfill_done` for enrich the way
// sync_cursors gives one for history, so the drained condition has to be
// derived from the warehouse — and deriving it from the same predicate that
// creates the work is what keeps the producer and the transition from
// disagreeing about when enrichment is finished.
//
// THE MARKER IS `stats_source`, NOT `additions`. A commit arrives from the
// history backfill with additions/deletions already populated when the list
// payload carried them, stamped stats_source='graphql' (writers.ts) — so
// "additions IS NULL" would declare almost every commit already enriched and
// enqueue nothing. Only upsertCommitFiles writes 'detail', and only it writes
// the per-file commit_files rows that churn/hotspot metrics actually read.

const NEEDS_CHURN = (repoId: number) =>
  and(
    eq(facts.commits.repoId, repoId),
    or(isNull(facts.commits.statsSource), ne(facts.commits.statsSource, 'detail')),
  );

export interface CommitNeedingChurn {
  id: number;
  sha: string;
}

/**
 * Commits with no file-level churn yet, oldest first. `limit` caps one fan-out:
 * the enrich lane is low-priority and drained by leftover budget (§2), so a
 * large repo spreads over several rounds rather than flooding the queue.
 */
export async function commitsNeedingChurn(
  db: DbOrTx,
  repoId: number,
  limit = 500,
): Promise<CommitNeedingChurn[]> {
  return db
    .select({ id: facts.commits.id, sha: facts.commits.sha })
    .from(facts.commits)
    .where(NEEDS_CHURN(repoId))
    .orderBy(facts.commits.id)
    .limit(limit);
}

/**
 * True when no commit in the repo is still awaiting churn — INGESTION §2's
 * "enrichment queue drained", expressed per repo.
 *
 * A repo with no commits at all counts as drained: there is nothing to enrich,
 * and holding such a repo at `backfilling` forever is a worse answer than
 * `live`.
 */
export async function isEnrichmentDrained(db: DbOrTx, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts.commits)
    .where(NEEDS_CHURN(repoId));
  return (row?.n ?? 0) === 0;
}
