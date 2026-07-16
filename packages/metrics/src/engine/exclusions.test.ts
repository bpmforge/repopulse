import { describe, expect, it } from 'vitest';
import { isEligibleForChurn, isMergeCommit } from './exclusions.js';

describe('isMergeCommit (METRICS.md §0)', () => {
  it('flags commits with more than one parent', () => {
    expect(isMergeCommit(2)).toBe(true);
    expect(isMergeCommit(3)).toBe(true);
  });

  it('does not flag ordinary single-parent (or root) commits', () => {
    expect(isMergeCommit(1)).toBe(false);
    expect(isMergeCommit(0)).toBe(false);
  });
});

describe('isEligibleForChurn (bot + merge-commit + superseded exclusions)', () => {
  const base = { authorLogin: 'alice', parentShaCount: 1, superseded: false };

  it('is eligible when none of the exclusions apply', () => {
    expect(isEligibleForChurn(base)).toBe(true);
  });

  it('excludes bot-authored commits', () => {
    expect(isEligibleForChurn({ ...base, authorLogin: 'renovate[bot]' })).toBe(false);
  });

  it('excludes merge commits', () => {
    expect(isEligibleForChurn({ ...base, parentShaCount: 2 })).toBe(false);
  });

  it('excludes superseded (tombstoned) commits', () => {
    expect(isEligibleForChurn({ ...base, superseded: true })).toBe(false);
  });

  it('honors a custom bot glob list', () => {
    expect(isEligibleForChurn({ ...base, authorLogin: 'octocat' }, ['octo*'])).toBe(false);
  });
});
