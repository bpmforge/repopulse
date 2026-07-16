import { describe, expect, it } from 'vitest';
import { computeIssueThroughput, computeOpenIssueAgeDistribution } from './issues.js';
import {
  ISSUES_AS_OF,
  ISSUES_EXPECTED,
  ISSUES_FIXTURE,
  ISSUES_WINDOW_END,
  ISSUES_WINDOW_START,
} from '../../fixtures/issues-releases/issues.js';

describe('computeIssueThroughput (METRICS.md §1 M10)', () => {
  it('matches the fixture: opened=2, closed=2 (reopen+reclose counted as 2), medianTimeToCloseDays=14', () => {
    const result = computeIssueThroughput(ISSUES_FIXTURE, ISSUES_WINDOW_START, ISSUES_WINDOW_END);
    expect(result).toEqual({
      opened: ISSUES_EXPECTED.opened,
      closed: ISSUES_EXPECTED.closed,
      medianTimeToCloseDays: ISSUES_EXPECTED.medianTimeToCloseDays,
    });
  });

  it('excludes PRs entirely (isPullRequest=true never counted, opened or closed)', () => {
    const onlyPr = ISSUES_FIXTURE.filter((i) => i.isPullRequest);
    const result = computeIssueThroughput(onlyPr, ISSUES_WINDOW_START, ISSUES_WINDOW_END);
    expect(result).toEqual({ opened: 0, closed: 0, medianTimeToCloseDays: null });
  });

  it('a close event outside the window is never counted, even if the issue has another qualifying one', () => {
    const issue2 = ISSUES_FIXTURE.find((i) => i.number === 2)!;
    const result = computeIssueThroughput([issue2], ISSUES_WINDOW_START, ISSUES_WINDOW_END);
    expect(result.closed).toBe(1); // only the June close, not the May one
  });

  it('returns null medianTimeToCloseDays when nothing closed in the window', () => {
    const result = computeIssueThroughput([], ISSUES_WINDOW_START, ISSUES_WINDOW_END);
    expect(result.medianTimeToCloseDays).toBeNull();
  });
});

describe('computeOpenIssueAgeDistribution (METRICS.md §1 M10)', () => {
  it('only includes issues open at the snapshot, PRs excluded', () => {
    const result = computeOpenIssueAgeDistribution(ISSUES_FIXTURE, ISSUES_AS_OF);
    expect(result.ageDays).toEqual([...ISSUES_EXPECTED.openAgeDays]);
    expect(result.p50Days).toBe(20);
    expect(result.p90Days).toBe(20);
  });

  it('returns an empty distribution when nothing is open', () => {
    const allClosed = ISSUES_FIXTURE.filter((i) => !i.isOpenAtSnapshot);
    const result = computeOpenIssueAgeDistribution(allClosed, ISSUES_AS_OF);
    expect(result.ageDays).toEqual([]);
    expect(result.p50Days).toBeNull();
  });
});
