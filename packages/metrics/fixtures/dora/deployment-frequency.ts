import type { DeploymentInput, ReleaseFallbackInput } from '../../src/metrics/dora.js';

export const DORA_WINDOW_START = new Date('2026-06-01T00:00:00Z');
export const DORA_WINDOW_END = new Date('2026-06-30T00:00:00Z');

// Fixture org: 4 deployment records - 2 successful prod deploys in window
// (counted), 1 successful staging deploy (env filter excludes it), 1
// failed prod deploy (status filter excludes it). Expected countInWindow=2.
export const DEPLOYMENTS_FIXTURE: readonly DeploymentInput[] = [
  { environment: 'production', createdAt: '2026-06-05T00:00:00Z', latestStatus: 'success' },
  { environment: 'production', createdAt: '2026-06-15T00:00:00Z', latestStatus: 'success' },
  { environment: 'staging', createdAt: '2026-06-10T00:00:00Z', latestStatus: 'success' },
  { environment: 'production', createdAt: '2026-06-20T00:00:00Z', latestStatus: 'failure' },
];

// Zero-deployment repo (e.g. Gitea, research §7) - falls back to releases.
export const RELEASES_FALLBACK_FIXTURE: readonly ReleaseFallbackInput[] = [
  { publishedAt: '2026-06-05T00:00:00Z', isDraft: false, isPrerelease: false },
  { publishedAt: '2026-06-20T00:00:00Z', isDraft: false, isPrerelease: false },
  { publishedAt: '2026-06-10T00:00:00Z', isDraft: true, isPrerelease: false }, // excluded
];
