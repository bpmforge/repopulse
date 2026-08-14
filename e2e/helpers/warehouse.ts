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
}

/**
 * Poll until `repo` has left pending_backfill and has rows, or time out.
 * Ingestion is asynchronous — the API returns as soon as the plan is enqueued,
 * so a single immediate read races the worker and would flake.
 */
export async function waitForIngestedRepo(
  org: string,
  name: string,
  timeoutMs = 25_000,
): Promise<IngestedCounts> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('waitForIngestedRepo: DATABASE_URL is not set');
  const db = createDb(url);
  const deadline = Date.now() + timeoutMs;
  let last: IngestedCounts = { repoId: 0, syncStatus: 'never-read', commits: 0, pullRequests: 0 };

  try {
    for (;;) {
      const [repo] = await db
        .select({ id: core.repos.id, syncStatus: core.repos.syncStatus })
        .from(core.repos)
        .where(and(eq(core.repos.org, org), eq(core.repos.name, name)))
        .limit(1);

      if (repo) {
        const count = async (table: typeof facts.commits | typeof facts.pullRequests) => {
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
        };
        if (last.syncStatus !== 'pending_backfill' && last.commits > 0 && last.pullRequests > 0) {
          return last;
        }
      }

      if (Date.now() > deadline) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await db.$client.end();
  }
}
