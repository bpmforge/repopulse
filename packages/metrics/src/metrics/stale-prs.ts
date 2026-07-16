import { daysBetween } from '../engine/windows.js';

// METRICS.md §1 M8. `lastActivityAt` is the ingest-maintained denormalization
// (packages/shared/src/db/schema/facts/pull-requests.ts) already resolved
// from every tracked activity kind (commit push, review, review-comment,
// issue-comment) - "any tracked activity resets the clock" is the ingest
// layer's job (a later wave), not recomputed here from raw events.
export interface StalePrInput {
  number: number;
  isOpen: boolean;
  isDraft: boolean;
  lastActivityAt: string; // ISO
}

export interface StalePrEntry {
  pr: number;
  daysSinceActivity: number;
}

export interface StalePrsResult {
  staleCount: number;
  stale: readonly StalePrEntry[];
  /** Drafts are reported in a separate series (METRICS.md §1 M8), never mixed into `stale`. */
  staleDraftCount: number;
  staleDrafts: readonly StalePrEntry[];
}

export const DEFAULT_STALE_THRESHOLD_DAYS = 7;

export function computeStalePrs(
  prs: readonly StalePrInput[],
  asOf: Date,
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): StalePrsResult {
  const stale: StalePrEntry[] = [];
  const staleDrafts: StalePrEntry[] = [];

  for (const pr of prs) {
    if (!pr.isOpen) continue;
    const daysSinceActivity = daysBetween(new Date(pr.lastActivityAt), asOf);
    if (daysSinceActivity <= staleThresholdDays) continue;
    const entry: StalePrEntry = { pr: pr.number, daysSinceActivity };
    if (pr.isDraft) staleDrafts.push(entry);
    else stale.push(entry);
  }

  return {
    staleCount: stale.length,
    stale,
    staleDraftCount: staleDrafts.length,
    staleDrafts,
  };
}
