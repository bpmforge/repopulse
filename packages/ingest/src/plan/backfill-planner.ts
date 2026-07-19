import { jobId } from '../queues/topology.js';

// Backfill planner (FR-INGEST-2/3/4, NFR-2), verbatim from INGESTION.md §3.
//
// Repo order: pushedAt desc (recently-active first). Entity order per repo:
// PRs → commits → checks → issues → releases/deployments. "Recent-first within
// entity" (sort=updated desc, walk backwards) is a per-job listing concern the
// entity worker (W2-03) implements; this planner fixes the deterministic
// enqueue order + the now−365d window boundary.

export const BACKFILL_WINDOW_DAYS = 365;

// Entity order — the sync_cursors entity_type CHECK vocabulary, sequenced per
// §3. releases/deployments are last (cheapest, least dashboard-critical).
export const ENTITY_ORDER = [
  'prs',
  'commits',
  'checks',
  'issues',
  'releases',
  'deployments',
] as const;

export type BackfillEntityType = (typeof ENTITY_ORDER)[number];

export interface PlannableRepo {
  repoId: number;
  /** ISO timestamp; null sorts last (never-pushed repos are least urgent). */
  pushedAt: string | null;
}

export interface BackfillJobSpec {
  repoId: number;
  entityType: BackfillEntityType;
  jobId: string;
  /** now−365d ISO — the `since` boundary the entity worker walks back to. */
  since: string;
}

function pushedAtDesc(a: PlannableRepo, b: PlannableRepo): number {
  if (a.pushedAt === b.pushedAt) return a.repoId - b.repoId; // stable tie-break
  if (a.pushedAt === null) return 1;
  if (b.pushedAt === null) return -1;
  return a.pushedAt < b.pushedAt ? 1 : -1;
}

/**
 * Deterministic backfill enqueue order for a connection's repos. `nowMs` is
 * injected (never Date.now() inline) so the window boundary is testable.
 */
export function planBackfill(repos: readonly PlannableRepo[], nowMs: number): BackfillJobSpec[] {
  const since = new Date(nowMs - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ordered = [...repos].sort(pushedAtDesc);
  const specs: BackfillJobSpec[] = [];
  for (const repo of ordered) {
    for (const entityType of ENTITY_ORDER) {
      specs.push({
        repoId: repo.repoId,
        entityType,
        jobId: jobId.backfillEntity(repo.repoId, entityType),
        since,
      });
    }
  }
  return specs;
}
