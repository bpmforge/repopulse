import type { CfrCommitInput, CfrDeploymentInput } from '../../src/metrics/dora.js';

// 3 deployments, only dep-A is followed by a same-env hotfix within 48h.
export const CFR_DEPLOYMENTS_FIXTURE: readonly CfrDeploymentInput[] = [
  { id: 'dep-A', environment: 'production', createdAt: '2026-06-05T00:00:00Z' },
  { id: 'dep-B', environment: 'production', createdAt: '2026-06-15T00:00:00Z' },
  { id: 'dep-C', environment: 'production', createdAt: '2026-06-20T00:00:00Z' },
];

export const CFR_COMMITS_FIXTURE: readonly CfrCommitInput[] = [
  {
    sha: 'c1',
    message: 'hotfix: fix null pointer in checkout',
    authoredAt: '2026-06-06T00:00:00Z', // 24h after dep-A -> triggers
    environment: 'production',
    isGithubRevertLinked: false,
  },
  {
    sha: 'c2',
    message: 'revert this later maybe',
    authoredAt: '2026-06-18T00:00:00Z', // 72h after dep-B -> outside 48h window, does NOT trigger
    environment: 'production',
    isGithubRevertLinked: false,
  },
  {
    sha: 'c3',
    message: 'add new dashboard widget',
    authoredAt: '2026-06-20T10:00:00Z', // 10h after dep-C but no revert/hotfix/rollback signal
    environment: 'production',
    isGithubRevertLinked: false,
  },
];

export const CFR_EXPECTED = {
  deployments: 3,
  failedDeployments: 1,
  cfr: 1 / 3,
  failedDeploymentIds: ['dep-A'],
} as const;
