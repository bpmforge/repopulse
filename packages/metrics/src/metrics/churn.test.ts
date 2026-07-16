import { describe, expect, it } from 'vitest';
import { computeChurn, computeFileChurn, computePersonChurn } from './churn.js';
import {
  CHURN_FIXTURE_EXPECTED,
  CHURN_FIXTURE_EXPECTED_CHAIN_B,
  CHURN_FIXTURE_TOUCHES,
} from '../../fixtures/churn/basic.js';

describe('computeChurn (METRICS.md §1 M1 — fixture repro "to the line")', () => {
  it('reproduces gross/net/rework exactly across both touch chains', () => {
    expect(computeChurn(CHURN_FIXTURE_TOUCHES)).toEqual(CHURN_FIXTURE_EXPECTED);
  });

  it('excludes bot, merge-commit, and superseded touches entirely', () => {
    // c4 (bot, +100/-100), c5 (merge, +200/-200), c6 (superseded, +300/-300)
    // would each dominate gross/net if not excluded - the exact-match
    // assertion above already proves this, this test names why.
    const { gross } = computeChurn(CHURN_FIXTURE_TOUCHES);
    expect(gross).toBeLessThan(100 + 200 + 300);
  });

  it('does not count a touch as rework once the prior touch is >=21 days old', () => {
    // c3 is 25 days after c2 on the same file - if rework mistakenly
    // included it, rework would be 30 (c2) + 10 (c3) = 40 for chain A alone,
    // pushing the combined total to 50, not 40.
    expect(computeChurn(CHURN_FIXTURE_TOUCHES).rework).toBe(CHURN_FIXTURE_EXPECTED.rework);
  });
});

describe('computeFileChurn (rename-chain aware)', () => {
  it('groups a renamed file with its pre-rename history under either path name', () => {
    expect(computeFileChurn(CHURN_FIXTURE_TOUCHES, 'new.ts')).toEqual(
      CHURN_FIXTURE_EXPECTED_CHAIN_B,
    );
    expect(computeFileChurn(CHURN_FIXTURE_TOUCHES, 'old.ts')).toEqual(
      CHURN_FIXTURE_EXPECTED_CHAIN_B,
    );
  });
});

describe('computePersonChurn', () => {
  it('scopes churn to a single author', () => {
    // bob only authored c3 (+5/-5, eligible, not rework since it's the
    // first (and only) touch attributed to bob in isolation).
    expect(computePersonChurn(CHURN_FIXTURE_TOUCHES, 'bob')).toEqual({
      gross: 10,
      net: 0,
      rework: 0,
    });
  });
});
