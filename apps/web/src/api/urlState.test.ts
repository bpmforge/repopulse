import { describe, expect, it } from 'vitest';
import { mergeGlobalSearch } from './urlState.js';
import type { GlobalSearch } from './urlState.js';

// W20-15. A topbar change (repository or time window) rebuilt the search from
// the three global keys alone, so it silently reset the page's own filters.

describe('mergeGlobalSearch keeps page filters (W20-15)', () => {
  const current = {
    window: '30d',
    repos: '3',
    status: 'open',
    severity: '5',
    finding: '812',
    cursor: 'c2',
  } as GlobalSearch;

  it('keeps page-level filters when the repository changes', () => {
    const next = mergeGlobalSearch(current, { repos: '7' });
    expect(next).toMatchObject({ repos: '7', status: 'open', severity: '5', finding: '812' });
  });

  it('keeps page-level filters when the time window changes', () => {
    const next = mergeGlobalSearch(current, { window: '90d' });
    expect(next).toMatchObject({ window: '90d', repos: '3', status: 'open', severity: '5' });
  });

  it('drops the paging cursor, which belongs to the old result set', () => {
    expect(mergeGlobalSearch(current, { repos: '7' })).not.toHaveProperty('cursor');
  });

  it('still clears a global filter on null', () => {
    const next = mergeGlobalSearch(current, { repos: null });
    expect(next).not.toHaveProperty('repos');
    expect(next).toMatchObject({ status: 'open' });
  });
});
