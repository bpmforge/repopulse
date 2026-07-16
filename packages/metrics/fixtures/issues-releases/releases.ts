import type { ReleaseInput, TagFallbackInput } from '../../src/metrics/releases.js';

export const RELEASES_WINDOW_START = new Date('2026-01-01T00:00:00Z');
export const RELEASES_AS_OF = new Date('2026-07-07T00:00:00Z');

// Three eligible releases (published, non-draft, non-prerelease) plus a
// draft and a prerelease that must both be excluded by default.
// Gaps: 2026-01-01 -> 2026-03-01 = 59d; 2026-03-01 -> 2026-06-01 = 92d.
// median([59, 92]) = 59 (nearest-rank p50 of 2). daysSinceLast (06-01 ->
// 07-07 asOf) = 36d.
export const RELEASES_FIXTURE: readonly ReleaseInput[] = [
  { isDraft: false, isPrerelease: false, publishedAt: '2026-01-01T00:00:00Z' },
  { isDraft: false, isPrerelease: false, publishedAt: '2026-03-01T00:00:00Z' },
  { isDraft: false, isPrerelease: false, publishedAt: '2026-06-01T00:00:00Z' },
  { isDraft: true, isPrerelease: false, publishedAt: null }, // draft - excluded
  { isDraft: false, isPrerelease: true, publishedAt: '2026-05-01T00:00:00Z' }, // prerelease - excluded by default
];

export const RELEASES_EXPECTED = {
  basis: 'releases',
  releasesInWindow: 3,
  medianGapDays: 59,
  daysSinceLast: 36,
} as const;

// Zero-release repo, falls back to pushed tags (basis = 'tags').
export const TAG_FALLBACKS_FIXTURE: readonly TagFallbackInput[] = [
  { pushedAt: '2026-02-01T00:00:00Z' },
  { pushedAt: '2026-04-01T00:00:00Z' },
];
