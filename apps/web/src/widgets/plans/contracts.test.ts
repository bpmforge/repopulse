import { describe, expect, it } from 'vitest';
import {
  criterionInWords,
  findingIdsOf,
  metricInWords,
  planScopeLabel,
  planSearchForRepo,
  repoIdsFromFilter,
  sameScope,
} from './contracts.js';

// W16-53. Every plan item spoke in raw metric ids — "Closes automatically when
// M6 stays at most 0.05 for 30 days" — on the screen whose whole job is getting
// a person to agree to a piece of work. The metric catalog exists so a screen
// can name a metric instead of numbering it, and the route serving it says the
// UI should read it and never hardcode; nothing had ever read it.
describe('metric names in a plan (W16-53)', () => {
  const names = { M5: 'Review coverage %', M6: 'Merged-without-review rate' };

  it('names the metric in the exit criterion', () => {
    const words = criterionInWords(
      { metricKey: 'M6', op: 'lte', target: 0.05, windowDays: 30, dimPath: [] },
      names,
    );
    expect(words).toContain('Merged-without-review rate');
  });

  it('keeps the id alongside the name', () => {
    // The id is what the catalog, the reports and the API all call this thing,
    // so a reader who wants to look it up still can.
    expect(metricInWords('M5', names)).toBe('Review coverage % (M5)');
  });

  it('falls back to the id rather than showing nothing', () => {
    // The catalog is a separate request. A criterion is still better shown with
    // an unresolved key than hidden while that request is in flight — or
    // forever, if a new metric has not reached the catalog yet.
    expect(metricInWords('M99', names)).toBe('M99');
    expect(metricInWords('M5', undefined)).toBe('M5');
  });
});

// W17-24. A plan keeps the scope it was generated for, and every label that
// names a scope is derived from the row — so a filter cannot imply a plan is
// broader or narrower than it is, and a finding reaches its repository's plan
// without anyone copying an id.
describe('plan scope (W17-24)', () => {
  it('reads the topbar repo filter as sorted, de-duplicated ids', () => {
    expect(repoIdsFromFilter('3,1,3')).toEqual([1, 3]);
    expect(repoIdsFromFilter('all')).toEqual([]);
    expect(repoIdsFromFilter(undefined)).toEqual([]);
    expect(repoIdsFromFilter('x,0,-2, 7 ')).toEqual([7]);
  });

  it('compares scopes as sets', () => {
    expect(sameScope([2, 1], [1, 2, 2])).toBe(true);
    expect(sameScope([], [])).toBe(true);
    expect(sameScope([1], [])).toBe(false);
    expect(sameScope([1], [1, 2])).toBe(false);
  });

  it('names the whole workspace, names known repositories, and COUNTS unknown ones', () => {
    const names = { 1: 'acme/api', 2: 'acme/web' };
    expect(planScopeLabel([])).toBe('the whole workspace');
    expect(planScopeLabel([2, 1], names)).toBe('acme/api, acme/web');
    // One unknown name makes the whole label a count: "acme/api, #9" would be
    // half a guess, and a count is true.
    expect(planScopeLabel([1, 9], names)).toBe('2 repositories');
    expect(planScopeLabel([9])).toBe('1 repository');
  });

  it('builds the Plans page search for a repository', () => {
    expect(planSearchForRepo(42)).toEqual({ repos: '42' });
  });

  it('links only the finding ids the generator recorded', () => {
    expect(findingIdsOf({ evidence: { findingIds: [7, 3, 'x', 0] } })).toEqual([7, 3]);
    expect(findingIdsOf({ evidence: { metricKeys: ['M6'] } })).toEqual([]);
    expect(findingIdsOf({ evidence: {} })).toEqual([]);
  });
});
