import { describe, expect, it } from 'vitest';
import { summariseFindings } from './findings-metric.js';
import { buildHealthSubScores, computeHealthScore, type HealthMetricInputs } from './health.js';

// The FINDINGS metric and the Supply Chain axis (W10-05, FR-REG-7).

const row = (over: Partial<Parameters<typeof summariseFindings>[0][number]> = {}) => ({
  id: 1,
  dimension: 'security',
  ruleId: null,
  severity: 3,
  file: 'src/a.ts',
  riskBand: 'track' as string | null,
  effectiveRisk: '10',
  yields: null,
  ...over,
});

describe('summarising findings for the catalog', () => {
  it('counts each register dimension separately', () => {
    const dims = summariseFindings(
      [
        row({ id: 1, dimension: 'knowledge' }),
        row({ id: 2, dimension: 'dependency_health' }),
        row({ id: 3, dimension: 'architecture' }),
        row({ id: 4, dimension: 'test_gap' }),
        row({ id: 5, dimension: 'security' }),
      ],
      null,
    );
    expect(dims.knowledgeFindingCount).toBe(1);
    expect(dims.dependencyHealthFindingCount).toBe(1);
    expect(dims.architectureFindingCount).toBe(1);
    expect(dims.testGapFindingCount).toBe(1);
    expect(dims.openCount).toBe(5);
  });

  it('carries finding IDS so a plan item can cite its evidence', () => {
    const dims = summariseFindings([row({ id: 42, dimension: 'test_gap' })], null);
    expect(dims.testGapFindingIds).toEqual([42]);
  });

  it('weights the supply-chain axis input by effective_risk, not by count', () => {
    // Ten libyear notices are not the same problem as one past-EOL runtime.
    const dims = summariseFindings(
      [
        row({ id: 1, dimension: 'dependency_health', effectiveRisk: '60' }),
        row({ id: 2, dimension: 'dependency_health', effectiveRisk: '2' }),
      ],
      null,
    );
    expect(dims.dependencyHealthRiskSum).toBe(62);
  });

  it('counts past-EOL runtimes on their rule id', () => {
    const dims = summariseFindings(
      [
        row({ id: 1, dimension: 'dependency_health', ruleId: 'eol.past' }),
        row({ id: 2, dimension: 'dependency_health', ruleId: 'eol.approaching' }),
      ],
      null,
    );
    expect(dims.eolRuntimeCount).toBe(1);
  });

  it('keeps slop density NULL when nothing has measured it', () => {
    // 0 would silence the very catalog entry that exists to notice slop.
    expect(summariseFindings([], null).slopDensity).toBeNull();
    expect(summariseFindings([], 4).slopDensity).toBe(4);
  });

  it('finds clusters by file, and only where there are enough of them', () => {
    const many = [1, 2, 3].map((id) => row({ id, file: 'src/hot.ts', severity: 4 }));
    const few = [4, 5].map((id) => row({ id, file: 'src/cold.ts', severity: 4 }));
    const dims = summariseFindings([...many, ...few], null);
    expect(dims.sevClusterCount).toBe(1);
  });

  it('spots a KEV or chain finding wherever it sits', () => {
    const dims = summariseFindings(
      [
        row({ id: 1, dimension: 'chain' }),
        row({ id: 2, dimension: 'dependency', yields: { kev: true } }),
        row({ id: 3 }),
      ],
      null,
    );
    expect(dims.kevOrChainOpen).toBe(2);
  });

  it('treats an unpriced finding as risk 0 without dropping it from counts', () => {
    const dims = summariseFindings([row({ id: 1, effectiveRisk: null })], null);
    expect(dims.openCount).toBe(1);
    expect(dims.riskSum).toBe(0);
  });
});

describe('the Supply Chain sub-score', () => {
  const base: HealthMetricInputs = {
    commitCountVsMedian: null,
    daysSinceLastPush: 1,
    m5ReviewCoverage: null,
    medianFirstReviewHours: null,
    stalePrCount: null,
    m9PassRate: null,
    topFlakiness: null,
    e2eCycleP50Hours: null,
    m11DaysSinceRelease: null,
    m12Cfr: null,
    openFindingDensity: null,
    worstOpenSeverity: null,
    duplicationPct: null,
    complexityP90: null,
    slopDensity: null,
    rework14d: null,
    supplyChainRisk: null,
    eolRuntimeCount: null,
  };

  it('is ABSENT when no register has run — never a clean score', () => {
    const score = computeHealthScore(buildHealthSubScores(base));
    expect(score.subScores.map((s) => s.key)).not.toContain('supplyChain');
    // Absent sub-scores renormalize the rest, which is the labelled case.
    expect(score.renormalized).toBe(true);
  });

  it('appears once there is something to say, and ranks worse with more risk', () => {
    const clean = computeHealthScore(
      buildHealthSubScores({ ...base, supplyChainRisk: 0, eolRuntimeCount: 0 }),
    );
    const bad = computeHealthScore(
      buildHealthSubScores({ ...base, supplyChainRisk: 12, eolRuntimeCount: 3 }),
    );
    const cleanAxis = clean.subScores.find((s) => s.key === 'supplyChain')!;
    const badAxis = bad.subScores.find((s) => s.key === 'supplyChain')!;
    expect(cleanAxis.normalized).toBe(100);
    expect(badAxis.normalized).toBe(0);
  });

  it('lets one past-EOL runtime move the axis on its own', () => {
    // EOL is a date, not an opinion — it should not be averaged away by an
    // otherwise-current dependency set.
    const withEol = computeHealthScore(
      buildHealthSubScores({ ...base, supplyChainRisk: 0, eolRuntimeCount: 3 }),
    );
    const axis = withEol.subScores.find((s) => s.key === 'supplyChain')!;
    expect(axis.normalized).toBeLessThan(100);
  });

  it('takes 0.10 of the weight per METRICS.md §3', () => {
    const defs = buildHealthSubScores(base);
    expect(defs.find((d) => d.key === 'supplyChain')?.weight).toBe(0.1);
  });
});
