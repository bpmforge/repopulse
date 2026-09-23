import { and, eq } from 'drizzle-orm';
import type { CallCtx, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import { facts, type Database } from '@repopulse/shared';
import { fetchOrRefusal, recordEnrichmentOutcome } from './entity-error.js';
import { upsertCommitFiles, type RepoScope } from './writers.js';

// Enrichment phase (INGESTION §2/§8, research §8): fills per-commit file churn
// so hotspots/ownership/churn metrics have file-level data. Runs in the
// low-priority `enrich` lane, drained by leftover budget.
//
// The "stats-first, 202-warmup retry" optimization (research §8 option A) reads
// repo-wide /stats/* endpoints that return 202 while GitHub computes them — but
// those endpoints are NOT on the ForgeProvider interface (FORGE_PROVIDER §4
// keeps them provider-internal, "optimization only"). The interface exposes
// only the per-commit REST fallback (getCommitFiles), which is exactly what the
// §8 fallback path uses. So enrichment goes straight to the reliable fallback;
// the stats-first fast path is a provider-internal concern for a later pass.

export interface EnrichDeps {
  db: Database;
  provider: ForgeProvider;
  provider_kind?: 'github' | 'gitea';
}

export interface EnrichCommitParams {
  workspaceId: number;
  repoId: number;
  repo: string;
  sha: string;
}

/**
 * Fill commit_files + roll churn totals onto the commit for one SHA. Paginates
 * the file list (≤3,000 files) and writes everything in one transaction so a
 * crash leaves the commit un-enriched (retryable), never half-enriched.
 */
export async function enrichCommitChurn(
  deps: EnrichDeps,
  params: EnrichCommitParams,
): Promise<number> {
  const ctx: CallCtx = { lane: 'reconcile', repoId: String(params.repoId) };
  const scope: RepoScope = { workspaceId: params.workspaceId, repoId: params.repoId };

  // Collect all file pages (network) before the write transaction. A
  // permanent refusal comes back as { refused } (W17-38); anything retryable
  // throws so the queue retries the job.
  const fetched = await fetchOrRefusal(async () => {
    const files: ForgeDiffFile[] = [];
    let cursor: string | undefined;
    let stats = { additions: 0, deletions: 0 };
    do {
      const page = await deps.provider.getCommitFiles(ctx, params.repo, params.sha, cursor);
      files.push(...page.items);
      stats = page.stats;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { files, stats };
  });

  return deps.db.transaction(async (tx) => {
    if (fetched.refused) {
      // Not 'detail' — nothing was measured — but out of the work-list, so one
      // vanished SHA cannot hold the repo in backfilling. The reason is on
      // sync_cursors('commit_files') and repos.last_error.
      await tx
        .update(facts.commits)
        .set({ statsSource: 'unavailable' })
        .where(and(eq(facts.commits.repoId, params.repoId), eq(facts.commits.sha, params.sha)));
      await recordEnrichmentOutcome(tx, scope, 'commit_files', fetched.refused);
      return 0;
    }
    const n = await upsertCommitFiles(
      tx,
      scope,
      params.sha,
      fetched.value.files,
      fetched.value.stats,
    );
    await recordEnrichmentOutcome(tx, scope, 'commit_files', null);
    return n;
  });
}
