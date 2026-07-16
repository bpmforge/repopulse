import type { CiRunInput } from '../../src/metrics/ci.js';

function run(overrides: Partial<CiRunInput>): CiRunInput {
  return {
    workflowName: 'build',
    headSha: 'sha',
    pullRequestId: null,
    status: 'completed',
    conclusion: 'success',
    runAttempt: 1,
    startedAt: '2026-07-01T00:00:00Z',
    completedAt: '2026-07-01T00:10:00Z',
    ...overrides,
  };
}

// "build" workflow: shaA reruns and flips fail->pass (flaky); shaB runs
// once, never rerun (not a rerun group at all).
// "test" workflow: shaC reruns but never flips (fail->fail).
// "lint" workflow: shaD reruns but both succeed (no flip, since neither
// attempt failed).
export const FLAKINESS_FIXTURE: readonly CiRunInput[] = [
  run({ workflowName: 'build', headSha: 'shaA', runAttempt: 1, conclusion: 'failure' }),
  run({ workflowName: 'build', headSha: 'shaA', runAttempt: 2, conclusion: 'success' }),
  run({ workflowName: 'build', headSha: 'shaB', runAttempt: 1, conclusion: 'success' }),
  run({ workflowName: 'test', headSha: 'shaC', runAttempt: 1, conclusion: 'failure' }),
  run({ workflowName: 'test', headSha: 'shaC', runAttempt: 2, conclusion: 'failure' }),
  run({ workflowName: 'lint', headSha: 'shaD', runAttempt: 1, conclusion: 'success' }),
  run({ workflowName: 'lint', headSha: 'shaD', runAttempt: 2, conclusion: 'success' }),
];

export const FLAKINESS_EXPECTED = {
  build: { rerunGroups: 1, flippedGroups: 1, flakinessRatio: 1 },
  test: { rerunGroups: 1, flippedGroups: 0, flakinessRatio: 0 },
  lint: { rerunGroups: 1, flippedGroups: 0, flakinessRatio: 0 },
} as const;
