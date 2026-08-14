import { and, eq, sql } from 'drizzle-orm';
import { core, facts, createDb } from '@repopulse/shared';

// Read OUR warehouse from a spec, so an ingestion assertion checks what landed
// in Postgres rather than what a screen happens to render. The dashboard read
// green for months against seeder-fabricated rows; only the tables settle it.

export interface IngestedCounts {
  /** Our warehouse id — the org overview keys its health tiles on it. */
  repoId: number;
  syncStatus: string;
  commits: number;
  pullRequests: number;
  /** Written by the ENRICHMENT phase; what churn/hotspot metrics read. */
  commitFiles: number;
  /** Per-PR enrichment: reviews and check runs. */
  reviews: number;
  checkRuns: number;
}

/**
 * Poll until `repo` has run the WHOLE pipeline — history backfilled, enrichment
 * drained, status `live` — or time out. Ingestion is asynchronous: the API
 * returns as soon as the plan is enqueued, so a single immediate read races the
 * worker and would flake.
 *
 * Waiting for `live` rather than merely "not pending_backfill" is deliberate.
 * `live` is only reachable once enrichment has drained (INGESTION §2), so it is
 * the single condition that proves every phase ran, and a regression in any one
 * of them stalls the repo at an earlier status instead of passing quietly.
 */
export async function waitForIngestedRepo(
  org: string,
  name: string,
  timeoutMs = 40_000,
): Promise<IngestedCounts> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('waitForIngestedRepo: DATABASE_URL is not set');
  const db = createDb(url);
  const deadline = Date.now() + timeoutMs;
  let last: IngestedCounts = {
    repoId: 0,
    syncStatus: 'never-read',
    commits: 0,
    pullRequests: 0,
    commitFiles: 0,
    reviews: 0,
    checkRuns: 0,
  };

  try {
    for (;;) {
      const [repo] = await db
        .select({ id: core.repos.id, syncStatus: core.repos.syncStatus })
        .from(core.repos)
        .where(and(eq(core.repos.org, org), eq(core.repos.name, name)))
        .limit(1);

      if (repo) {
        const count = async (
          table:
            | typeof facts.commits
            | typeof facts.pullRequests
            | typeof facts.commitFiles
            | typeof facts.prReviews
            | typeof facts.checkRuns,
        ) => {
          const [row] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(table)
            .where(eq(table.repoId, repo.id));
          return row?.n ?? 0;
        };
        last = {
          repoId: repo.id,
          syncStatus: repo.syncStatus,
          commits: await count(facts.commits),
          pullRequests: await count(facts.pullRequests),
          commitFiles: await count(facts.commitFiles),
          reviews: await count(facts.prReviews),
          checkRuns: await count(facts.checkRuns),
        };
        // `live` ALONE is the completion signal: it is only reachable once
        // history finished and both halves of enrichment drained (INGESTION
        // §2). Also requiring commits/PRs > 0 was wrong — a real repo with no
        // pull requests (bpmforge/quarry has none) can never satisfy it, so the
        // poll ran to its deadline on a repo that had in fact finished
        // perfectly. Row counts are the CALLER's assertion, not the wait
        // condition; conflating them made the helper repo-shape-dependent.
        if (last.syncStatus === 'live') return last;
      }

      if (Date.now() > deadline) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await db.$client.end();
  }
}
