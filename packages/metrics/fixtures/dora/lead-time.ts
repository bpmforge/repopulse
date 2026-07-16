import type { DeploymentCommitInterval } from '../../src/metrics/dora.js';

// Pooled across 2 deployments: hours = [12, 24, 12]. sorted = [12, 12, 24].
// median (nearest-rank p50 of 3) = 2nd smallest = 12. p90 = 3rd smallest = 24.
export const LEAD_TIME_FIXTURE: readonly DeploymentCommitInterval[] = [
  { deployedAt: '2026-06-05T12:00:00Z', changeTime: '2026-06-05T00:00:00Z' }, // 12h
  { deployedAt: '2026-06-05T12:00:00Z', changeTime: '2026-06-04T12:00:00Z' }, // 24h
  { deployedAt: '2026-06-15T12:00:00Z', changeTime: '2026-06-15T00:00:00Z' }, // 12h
];

export const LEAD_TIME_EXPECTED = { medianHours: 12, p90Hours: 24 } as const;
