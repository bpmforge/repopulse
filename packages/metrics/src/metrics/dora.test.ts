import { describe, expect, it } from 'vitest';
import {
  computeChangeFailureRate,
  computeDeploymentFrequency,
  computeLeadTimeForChanges,
  computeMttr,
} from './dora.js';
import {
  DEPLOYMENTS_FIXTURE,
  DORA_WINDOW_END,
  DORA_WINDOW_START,
  RELEASES_FALLBACK_FIXTURE,
} from '../../fixtures/dora/deployment-frequency.js';
import { LEAD_TIME_EXPECTED, LEAD_TIME_FIXTURE } from '../../fixtures/dora/lead-time.js';
import {
  CFR_COMMITS_FIXTURE,
  CFR_DEPLOYMENTS_FIXTURE,
  CFR_EXPECTED,
} from '../../fixtures/dora/change-failure-rate.js';

describe('computeDeploymentFrequency (METRICS.md §1 M12)', () => {
  it('basis=deployments: counts only successful prod-like deploys in window (2 of 4)', () => {
    const result = computeDeploymentFrequency(
      DEPLOYMENTS_FIXTURE,
      [],
      DORA_WINDOW_START,
      DORA_WINDOW_END,
    );
    expect(result.basis).toBe('deployments');
    expect(result.countInWindow).toBe(2);
    expect(result.caveat).toContain('env filter defaults to prod-like');
  });

  it('falls back to releases (basis=releases) when there are zero deployment records at all', () => {
    const result = computeDeploymentFrequency(
      [],
      RELEASES_FALLBACK_FIXTURE,
      DORA_WINDOW_START,
      DORA_WINDOW_END,
    );
    expect(result.basis).toBe('releases');
    expect(result.countInWindow).toBe(2); // draft release excluded
  });

  it('does NOT fall back when deployment records exist but none are successful/in-window (basis stays deployments)', () => {
    const onlyFailed = DEPLOYMENTS_FIXTURE.filter((d) => d.latestStatus === 'failure');
    const result = computeDeploymentFrequency(
      onlyFailed,
      RELEASES_FALLBACK_FIXTURE,
      DORA_WINDOW_START,
      DORA_WINDOW_END,
    );
    expect(result.basis).toBe('deployments');
    expect(result.countInWindow).toBe(0);
  });
});

describe('computeLeadTimeForChanges (METRICS.md §1 M12 — pooled across deployments)', () => {
  it('matches the fixture exactly: median 12h, p90 24h', () => {
    const result = computeLeadTimeForChanges(LEAD_TIME_FIXTURE);
    expect(result.medianHours).toBe(LEAD_TIME_EXPECTED.medianHours);
    expect(result.p90Hours).toBe(LEAD_TIME_EXPECTED.p90Hours);
    expect(result.caveat).toContain('no runtime confirmation');
  });

  it('returns null for an empty input, never a fabricated number', () => {
    const result = computeLeadTimeForChanges([]);
    expect(result.medianHours).toBeNull();
    expect(result.p90Hours).toBeNull();
  });
});

describe('computeChangeFailureRate (METRICS.md §1 M12 — revert/hotfix heuristic, 48h same-env)', () => {
  it('matches the fixture exactly: 1/3 deployments failed, dep-A drill-down', () => {
    const result = computeChangeFailureRate(CFR_DEPLOYMENTS_FIXTURE, CFR_COMMITS_FIXTURE);
    expect(result.deployments).toBe(CFR_EXPECTED.deployments);
    expect(result.failedDeployments).toBe(CFR_EXPECTED.failedDeployments);
    expect(result.cfr).toBeCloseTo(CFR_EXPECTED.cfr, 5);
    expect(result.failedDeploymentIds).toEqual([...CFR_EXPECTED.failedDeploymentIds]);
  });

  it('a matching commit outside the 48h window never counts (dep-B)', () => {
    const result = computeChangeFailureRate(CFR_DEPLOYMENTS_FIXTURE, CFR_COMMITS_FIXTURE);
    expect(result.failedDeploymentIds).not.toContain('dep-B');
  });

  it('a commit with no revert/hotfix/rollback signal and no GitHub revert link never counts (dep-C)', () => {
    const result = computeChangeFailureRate(CFR_DEPLOYMENTS_FIXTURE, CFR_COMMITS_FIXTURE);
    expect(result.failedDeploymentIds).not.toContain('dep-C');
  });

  it('a commit BEFORE the deployment never counts, even within 48h', () => {
    const before = [
      {
        sha: 'c-before',
        message: 'hotfix applied early somehow',
        authoredAt: '2026-06-04T00:00:00Z', // before dep-A's 06-05 createdAt
        environment: 'production',
        isGithubRevertLinked: false,
      },
    ];
    const result = computeChangeFailureRate([CFR_DEPLOYMENTS_FIXTURE[0]!], before);
    expect(result.failedDeploymentIds).toEqual([]);
  });

  it('a GitHub revert-linked commit counts even without a matching message', () => {
    const linked = [
      {
        sha: 'c-linked',
        message: 'unrelated message text',
        authoredAt: '2026-06-05T10:00:00Z',
        environment: 'production',
        isGithubRevertLinked: true,
      },
    ];
    const result = computeChangeFailureRate([CFR_DEPLOYMENTS_FIXTURE[0]!], linked);
    expect(result.failedDeploymentIds).toEqual(['dep-A']);
  });

  it('returns null cfr (never 0) when there are zero deployments', () => {
    expect(computeChangeFailureRate([], []).cfr).toBeNull();
  });
});

describe('computeMttr (METRICS.md §1 M12 honesty caveat)', () => {
  it('never returns a fabricated number - always needs_incident_data', () => {
    const result = computeMttr();
    expect(result.status).toBe('needs_incident_data');
    expect(result.value).toBeNull();
    expect(result.caveat).toContain('no incident source');
  });
});
