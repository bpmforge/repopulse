import type { CiRunInput } from '../../src/metrics/ci.js';

// Default-branch runs (pullRequestId: null): 3 in the passRate denominator
// (success/success/failure), 1 cancelled + 1 skipped (excluded from the
// denominator entirely), 1 in_progress (excluded before conclusion is even
// considered). passRate = 2/3.
export const DEFAULT_BRANCH_RUNS: readonly CiRunInput[] = [
  {
    workflowName: 'build',
    headSha: 'sha1',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'success',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:10:00Z', // 10 min
  },
  {
    workflowName: 'build',
    headSha: 'sha2',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'success',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:20:00Z', // 20 min
  },
  {
    workflowName: 'build',
    headSha: 'sha3',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'failure',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:30:00Z', // 30 min
  },
  {
    workflowName: 'build',
    headSha: 'sha4',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'cancelled',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:01:00Z',
  },
  {
    workflowName: 'build',
    headSha: 'sha5',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'skipped',
    runAttempt: 1,
    startedAt: null,
    completedAt: null,
  },
  {
    workflowName: 'build',
    headSha: 'sha6',
    pullRequestId: null,
    status: 'in_progress',
    conclusion: null,
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: null,
  },
];

// PR runs (pullRequestId: 42): 1 success, 1 failure -> passRate = 1/2.
export const PULL_REQUEST_RUNS: readonly CiRunInput[] = [
  {
    workflowName: 'build',
    headSha: 'sha7',
    pullRequestId: 42,
    status: 'completed',
    conclusion: 'success',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:05:00Z',
  },
  {
    workflowName: 'build',
    headSha: 'sha8',
    pullRequestId: 42,
    status: 'completed',
    conclusion: 'failure',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:05:00Z',
  },
];
