import { median } from '../engine/percentiles.js';
import { daysBetween } from '../engine/windows.js';

// METRICS.md §1 M11.
export interface ReleaseInput {
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string | null;
}

export interface TagFallbackInput {
  pushedAt: string;
}

export type ReleaseCadenceBasis = 'releases' | 'tags';

export interface ReleaseCadenceResult {
  /** "tags" only when the repo has zero eligible releases and at least one pushed tag exists. */
  basis: ReleaseCadenceBasis;
  releasesInWindow: number;
  medianGapDays: number | null;
  daysSinceLast: number | null;
}

function summarize(
  sortedDates: readonly string[],
  basis: ReleaseCadenceBasis,
  windowStart: Date,
  asOf: Date,
): ReleaseCadenceResult {
  const releasesInWindow = sortedDates.filter((d) => {
    const at = new Date(d);
    return at >= windowStart && at <= asOf;
  }).length;

  const gapsDays: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gapsDays.push(
      daysBetween(new Date(sortedDates[i - 1] as string), new Date(sortedDates[i] as string)),
    );
  }

  const last = sortedDates[sortedDates.length - 1];
  return {
    basis,
    releasesInWindow,
    medianGapDays: median(gapsDays),
    daysSinceLast: last ? daysBetween(new Date(last), asOf) : null,
  };
}

/**
 * METRICS.md §1 M11: published, non-draft releases (prereleases config-
 * optional, default off). Falls back to pushed tags (basis='tags') only
 * when there are zero eligible releases at all.
 */
export function computeReleaseCadence(
  releases: readonly ReleaseInput[],
  tagFallbacks: readonly TagFallbackInput[],
  windowStart: Date,
  asOf: Date,
  includePrereleases = false,
): ReleaseCadenceResult {
  const eligible = releases
    .filter((r) => !r.isDraft && r.publishedAt !== null && (includePrereleases || !r.isPrerelease))
    .map((r) => r.publishedAt as string)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  if (eligible.length === 0 && tagFallbacks.length > 0) {
    const sortedTags = [...tagFallbacks]
      .map((t) => t.pushedAt)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return summarize(sortedTags, 'tags', windowStart, asOf);
  }

  return summarize(eligible, 'releases', windowStart, asOf);
}
