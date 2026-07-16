import { describe, expect, it } from 'vitest';
import { computeCiDuration, computeCiFlakiness, computeCiPassRate } from './ci.js';
import { DEFAULT_BRANCH_RUNS, PULL_REQUEST_RUNS } from '../../fixtures/ci/pass-rate.js';
import { FLAKINESS_EXPECTED, FLAKINESS_FIXTURE } from '../../fixtures/ci/flakiness.js';

describe('computeCiPassRate (METRICS.md §1 M9)', () => {
  it('default-branch passRate excludes cancelled/skipped/in-progress: 2/3', () => {
    expect(computeCiPassRate(DEFAULT_BRANCH_RUNS)).toBeCloseTo(2 / 3, 5);
  });

  it('PR passRate is reported separately from default-branch: 1/2', () => {
    expect(computeCiPassRate(PULL_REQUEST_RUNS)).toBeCloseTo(1 / 2, 5);
  });

  it('an in-progress run never enters the denominator, even indirectly', () => {
    const onlyInProgress = DEFAULT_BRANCH_RUNS.filter((r) => r.status === 'in_progress');
    expect(computeCiPassRate(onlyInProgress)).toBeNull();
  });

  it('returns null (never 0) when there is no eligible run at all', () => {
    expect(computeCiPassRate([])).toBeNull();
  });
});

describe('computeCiDuration (median + p90)', () => {
  it('computes median/p90 in ms from every completed run with both timestamps (1/10/20/30 min, including the cancelled run - duration has no pass-rate-style exclusion)', () => {
    const result = computeCiDuration(DEFAULT_BRANCH_RUNS);
    // sorted ms: 60_000 (cancelled, 1min), 600_000 (10min), 1_200_000 (20min), 1_800_000 (30min)
    expect(result.medianMs).toBe(10 * 60 * 1000); // nearest-rank p50 of 4 -> 2nd smallest
    expect(result.p90Ms).toBe(30 * 60 * 1000); // nearest-rank p90 of 4 -> 4th smallest
  });

  it('excludes runs missing startedAt/completedAt (the skipped/in-progress fixture rows)', () => {
    const result = computeCiDuration(DEFAULT_BRANCH_RUNS);
    // Only 3 of the 6 fixture rows have both timestamps + status=completed.
    expect(result.medianMs).not.toBeNull();
  });

  it('returns null for an empty or all-incomplete input', () => {
    expect(computeCiDuration([]).medianMs).toBeNull();
  });
});

describe('computeCiFlakiness (METRICS.md §1 M9 — ranked desc)', () => {
  it('matches the fixture exactly and ranks the flaky workflow first', () => {
    const result = computeCiFlakiness(FLAKINESS_FIXTURE);
    const byName = Object.fromEntries(result.map((r) => [r.workflowName, r]));

    expect(byName.build).toMatchObject(FLAKINESS_EXPECTED.build);
    expect(byName.test).toMatchObject(FLAKINESS_EXPECTED.test);
    expect(byName.lint).toMatchObject(FLAKINESS_EXPECTED.lint);
    expect(result[0]?.workflowName).toBe('build');
  });

  it('a workflow run only once (never rerun) contributes to no group at all', () => {
    // shaB (build, single run) must not inflate build's rerunGroups beyond 1.
    const result = computeCiFlakiness(FLAKINESS_FIXTURE);
    const build = result.find((r) => r.workflowName === 'build')!;
    expect(build.rerunGroups).toBe(1);
  });

  it('returns an empty list when nothing was ever rerun', () => {
    const neverRerun = FLAKINESS_FIXTURE.filter((r) => r.runAttempt === 1);
    expect(computeCiFlakiness(neverRerun)).toEqual([]);
  });
});
