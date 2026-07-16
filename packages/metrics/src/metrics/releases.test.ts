import { describe, expect, it } from 'vitest';
import { computeReleaseCadence } from './releases.js';
import {
  RELEASES_AS_OF,
  RELEASES_EXPECTED,
  RELEASES_FIXTURE,
  RELEASES_WINDOW_START,
  TAG_FALLBACKS_FIXTURE,
} from '../../fixtures/issues-releases/releases.js';

describe('computeReleaseCadence (METRICS.md §1 M11)', () => {
  it('matches the fixture exactly: basis=releases, 3 in window, median gap 59d, 36d since last', () => {
    const result = computeReleaseCadence(
      RELEASES_FIXTURE,
      [],
      RELEASES_WINDOW_START,
      RELEASES_AS_OF,
    );
    expect(result).toEqual(RELEASES_EXPECTED);
  });

  it('excludes draft and (by default) prerelease releases', () => {
    const result = computeReleaseCadence(
      RELEASES_FIXTURE,
      [],
      RELEASES_WINDOW_START,
      RELEASES_AS_OF,
    );
    expect(result.releasesInWindow).toBe(3); // not 5 - draft + prerelease excluded
  });

  it('includes prereleases when explicitly configured to', () => {
    const result = computeReleaseCadence(
      RELEASES_FIXTURE,
      [],
      RELEASES_WINDOW_START,
      RELEASES_AS_OF,
      true,
    );
    expect(result.releasesInWindow).toBe(4); // 3 + the prerelease, draft still excluded
  });

  it('falls back to pushed tags (basis=tags) when there are zero eligible releases', () => {
    const result = computeReleaseCadence(
      [],
      TAG_FALLBACKS_FIXTURE,
      RELEASES_WINDOW_START,
      RELEASES_AS_OF,
    );
    expect(result.basis).toBe('tags');
    expect(result.releasesInWindow).toBe(2);
  });

  it('reports basis=releases with all-null fields when there are neither releases nor tags', () => {
    const result = computeReleaseCadence([], [], RELEASES_WINDOW_START, RELEASES_AS_OF);
    expect(result).toEqual({
      basis: 'releases',
      releasesInWindow: 0,
      medianGapDays: null,
      daysSinceLast: null,
    });
  });
});
