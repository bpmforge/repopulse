import type { CallCtx, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import type { Database } from '@repopulse/shared';
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

  // Collect all file pages (network) before the write transaction.
  const allFiles: ForgeDiffFile[] = [];
  let cursor: string | undefined;
  let stats = { additions: 0, deletions: 0 };
  do {
    const page = await deps.provider.getCommitFiles(ctx, params.repo, params.sha, cursor);
    allFiles.push(...page.items);
    stats = page.stats;
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return deps.db.transaction((tx) => upsertCommitFiles(tx, scope, params.sha, allFiles, stats));
}
