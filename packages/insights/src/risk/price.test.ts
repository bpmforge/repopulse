import { describe, expect, it } from 'vitest';
import {
  RISK_MODEL_V1,
  RISK_MODEL_V2,
  RISK_MODEL_V3,
  RISK_MODEL_VERSION,
  bandFor,
} from './model.js';
import {
  exposureFor,
  hazardFor,
  importGraphMultiplier,
  likelihoodFor,
  priceFinding,
  recomputeFromFactors,
  type PricingInput,
} from './price.js';

// Risk pricing (W9-09, RISK_MODEL.md §2/§3, FR-RISK-1/2/3/4).

const base: PricingInput = {
  dimension: 'sast',
  severity: 4,
  confidence: 4,
  verifyStatus: 'confirmed',
  ruleFpRate: 0,
  hotspotPercentile: 1,
};

describe('hazard', () => {
  it('is severity on the canonical scale', () => {
    expect(hazardFor(5)).toBe(1);
    expect(hazardFor(3)).toBeCloseTo(0.6, 10);
    expect(hazardFor(1)).toBeCloseTo(0.2, 10);
  });
});

describe('likelihood (FR-RISK-2)', () => {
  it('multiplies confidence, verification and rule precision', () => {
    // 4/5 × 1.0 (confirmed) × (1 − 0.1 fp) = 0.72
    expect(likelihoodFor({ ...base, ruleFpRate: 0.1 })).toBeCloseTo(0.72, 10);
  });

  it('discounts an unverified finding and nearly erases a contradicted one', () => {
    expect(likelihoodFor({ ...base, verifyStatus: 'unverified' })).toBeCloseTo(0.8 * 0.7, 10);
    expect(likelihoodFor({ ...base, verifyStatus: 'contradicted' })).toBeCloseTo(0.8 * 0.15, 10);
  });

  it('prices a rule with NO stats at 0.7, not 1.0', () => {
    // Unmeasured is not perfect. Pricing it as perfect would float every
    // brand-new rule to the top of the list on its first day.
    expect(likelihoodFor({ ...base, ruleFpRate: null })).toBeCloseTo(0.8 * 0.7, 10);
  });

  it('floors rule precision, so a bad rule still reports something', () => {
    expect(likelihoodFor({ ...base, ruleFpRate: 0.99 })).toBeCloseTo(0.8 * 0.3, 10);
  });

  it('v2: uses the dependency branch for CVEs: EPSS, or the floor', () => {
    const dep: PricingInput = { ...base, dimension: 'dependency' };
    expect(likelihoodFor({ ...dep, epss: 0.4 }, RISK_MODEL_V2)).toBe(0.4);
    // No EPSS and no KEV means we do not KNOW it is exploited — the floor,
    // not zero and not a guess. This is also today's reality: the EPSS feed
    // is parked with W8-13.
    expect(likelihoodFor(dep, RISK_MODEL_V2)).toBe(RISK_MODEL_V1.dependencyLikelihoodFloor);
  });

  // 2026-10-28 walkthrough: with no EPSS feed every CVE sat at the 0.05 floor,
  // and a confirmed critical CVE in a direct dependency (3.0) ranked under a
  // test gap (23.5). v3 prices the match like any other evidence.
  it('v3: a CVE is at least as likely as its evidence, and EPSS can only raise it', () => {
    const dep: PricingInput = { ...base, dimension: 'dependency', confidence: 5 };
    expect(likelihoodFor({ ...dep, verifyStatus: 'confirmed' })).toBeCloseTo(0.7, 10);
    expect(likelihoodFor({ ...dep, verifyStatus: 'unverified' })).toBeCloseTo(0.49, 10);
    expect(likelihoodFor({ ...dep, verifyStatus: 'contradicted' })).toBeCloseTo(0.105, 10);
    expect(likelihoodFor({ ...dep, verifyStatus: 'confirmed', epss: 0.9 })).toBe(0.9);
    // The confirmed critical CVE from the walkthrough: H 1, X 0.6 (manifest only).
    const cve = priceFinding({
      ...dep,
      severity: 5,
      verifyStatus: 'confirmed',
      depScope: { kind: 'prod-direct' },
    });
    expect(cve.effectiveRisk).toBe(42);
    expect(cve.band).toBe('schedule');
    // A contradicted CVE stays at the bottom of the list.
    expect(priceFinding({ ...dep, severity: 5, verifyStatus: 'contradicted' }).band).toBe('track');
  });

  it('prices an installed malicious package as act, whatever the arithmetic', () => {
    const mal = priceFinding({
      ...base,
      dimension: 'dependency',
      severity: 5,
      maliciousPackage: true,
    });
    expect(mal.riskFactors.L).toBe(1);
    expect(mal.band).toBe('act');
  });

  it('overrides to 1.0 for KEV, verified secrets, chains and compounds', () => {
    expect(likelihoodFor({ ...base, dimension: 'dependency', kev: true })).toBe(1);
    expect(likelihoodFor({ ...base, verifiedSecret: true })).toBe(1);
    expect(likelihoodFor({ ...base, dimension: 'chain', confidence: 1 })).toBe(1);
    expect(likelihoodFor({ ...base, dimension: 'compound', confidence: 1 })).toBe(1);
  });
});

describe('compound override (v4, owner decision 2026-10-28)', () => {
  const cluster = { ...base, dimension: 'compound' as const, severity: 5, confidence: 4 };

  it('keeps the override when a member dimension is a security one', () => {
    const priced = priceFinding({
      ...cluster,
      compoundDimensions: ['code_health', 'sast', 'test_gap'],
    });
    expect(priced.riskFactors.L).toBe(1);
    expect(priced.band).toBe('act');
  });

  it('prices a code-health-only cluster on its own evidence, not as "act"', () => {
    const priced = priceFinding({
      ...cluster,
      verifyStatus: 'unverified',
      ruleFpRate: null,
      hotspotPercentile: 0.5,
      compoundDimensions: ['code_health', 'performance', 'test_gap'],
    });
    expect(priced.riskFactors.L).toBeLessThan(1);
    expect(priced.band).not.toBe('act');
  });

  it('keeps the override when the members are unknown', () => {
    expect(priceFinding(cluster).band).toBe('act');
  });

  it('v3 overrides every cluster, so an old score still reproduces', () => {
    const priced = priceFinding(
      { ...cluster, compoundDimensions: ['code_health', 'performance', 'test_gap'] },
      RISK_MODEL_V3,
    );
    expect(priced.band).toBe('act');
    expect(priced.riskFactors.model_version).toBe('risk_model.v3');
  });
});

describe('exposure (FR-RISK-3)', () => {
  it('maps hotspot percentile into [0.25, 1.0]', () => {
    expect(exposureFor({ ...base, hotspotPercentile: 1 })).toBe(1);
    expect(exposureFor({ ...base, hotspotPercentile: 0.5 })).toBeCloseTo(0.625, 10);
  });

  it('FLOORS a cold file at 0.25 rather than erasing it', () => {
    // A critical finding in a file nobody touches is still a critical finding.
    // Zero exposure would remove it from every ordered list forever.
    expect(exposureFor({ ...base, hotspotPercentile: 0 })).toBe(0.25);
  });

  it('gives a repo-scoped finding full exposure', () => {
    // No file to be hot or cold — it applies to the whole repository.
    expect(exposureFor({ ...base, repoScoped: true, hotspotPercentile: null })).toBe(1);
  });

  it('does not discount a file whose hotspot is UNKNOWN', () => {
    // "We have not measured this file" must not quietly halve a real finding.
    expect(exposureFor({ ...base, hotspotPercentile: null })).toBe(1);
  });

  it('prices dependency scope and reachability', () => {
    const dep: PricingInput = { ...base, dimension: 'dependency' };
    expect(
      exposureFor({ ...dep, depScope: { kind: 'prod-direct' }, reachability: 'symbol_reachable' }),
    ).toBe(1);
    // prod-transitive at depth 3: 0.8 − 0.05×2 = 0.7, × imported 0.85
    expect(
      exposureFor({
        ...dep,
        depScope: { kind: 'prod-transitive', depth: 3 },
        reachability: 'imported',
      }),
    ).toBeCloseTo(0.7 * 0.85, 10);
    // dev × proven_unreachable = 0.35 × 0.2 = 0.07 — near the bottom, and NOT
    // hidden. A proof of unreachability is a proof about today's call graph.
    expect(
      exposureFor({ ...dep, depScope: { kind: 'dev' }, reachability: 'proven_unreachable' }),
    ).toBeCloseTo(0.07, 10);
  });

  it('treats unknown reachability as manifest_only, never as proven', () => {
    const dep: PricingInput = {
      ...base,
      dimension: 'dependency',
      depScope: { kind: 'prod-direct' },
    };
    expect(exposureFor(dep)).toBe(RISK_MODEL_V1.reachability.manifest_only);
  });
});

describe('the score and its bands (FR-RISK-4)', () => {
  it('is 100·H·L·X, rounded to two places', () => {
    const priced = priceFinding(base);
    // 0.8 × 0.8 × 1.0 × 100 = 64
    expect(priced.effectiveRisk).toBe(64);
    expect(priced.band).toBe('act');
  });

  it('bands on the catalog thresholds', () => {
    expect(bandFor(55)).toBe('act');
    expect(bandFor(54.99)).toBe('schedule');
    expect(bandFor(25)).toBe('schedule');
    expect(bandFor(24.99)).toBe('track');
  });

  it('sends an override straight to act, whatever the arithmetic says', () => {
    // The score is a summary of an argument that has already been made.
    const tiny = priceFinding({ ...base, dimension: 'chain', severity: 1, confidence: 1 });
    expect(tiny.band).toBe('act');
    expect(bandFor(1, { kev: true })).toBe('act');
    expect(bandFor(1, { verifiedSecret: true })).toBe('act');
  });

  it('a dev-scoped, proven-unreachable CVE lands near the bottom but is NOT hidden', () => {
    const priced = priceFinding({
      dimension: 'dependency',
      severity: 5,
      confidence: 5,
      depScope: { kind: 'dev' },
      reachability: 'proven_unreachable',
    });
    expect(priced.band).toBe('track');
    // Present, not zero: it still sorts, and it still appears in the explorer.
    expect(priced.effectiveRisk).toBeGreaterThan(0);
  });
});

describe('the decomposition is the honesty rule', () => {
  it('recomputing from served factors reproduces the stored score', () => {
    // What the UI popover rests on: if this ever diverged, the arithmetic
    // shown to a user would not be the arithmetic that produced their number.
    for (const input of [
      base,
      { ...base, dimension: 'dependency' as const, epss: 0.3, depScope: { kind: 'dev' as const } },
      { ...base, hotspotPercentile: 0, verifyStatus: 'unverified' as const },
      { ...base, dimension: 'compound' as const },
    ]) {
      const priced = priceFinding(input);
      expect(recomputeFromFactors(priced.riskFactors)).toBe(priced.effectiveRisk);
    }
  });

  it('stamps the model version, so an old score explains itself', () => {
    expect(priceFinding(base).riskFactors.model_version).toBe(RISK_MODEL_VERSION);
  });

  it('carries every input, including the absent ones as null', () => {
    // A null EPSS says "no feed"; an omitted key would say nothing at all.
    const factors = priceFinding({ ...base, dimension: 'dependency' }).riskFactors;
    expect(factors.inputs).toMatchObject({ epss: null, kev: false, reachability: null });
  });

  it('is a pure function: the same finding prices the same way twice', () => {
    expect(JSON.stringify(priceFinding(base))).toBe(JSON.stringify(priceFinding(base)));
  });
});

describe('import-graph exposure (W18-25)', () => {
  // Mid-range hotspot, so both a discount and a raise have room to show.
  const mid: PricingInput = { ...base, hotspotPercentile: 0.5 };
  const xMid = exposureFor(mid);

  it('discounts a file nothing imports', () => {
    const x = exposureFor({ ...mid, importGraph: { state: 'orphan', fanIn: 0 } });
    expect(x).toBeCloseTo(xMid * 0.6, 10);
  });

  it('raises a high fan-in file, log-scaled and capped', () => {
    const at = (fanIn: number) =>
      exposureFor({ ...mid, importGraph: { state: 'imported', fanIn } });
    expect(at(2)).toBe(xMid);
    expect(at(8)).toBeGreaterThan(xMid);
    expect(at(32)).toBeCloseTo(xMid * 1.3, 10);
    expect(at(500)).toBe(at(32));
    expect(at(8)).toBeLessThan(at(32));
  });

  it('never pushes a finding below the cold-file floor, nor X above 1', () => {
    const cold = { ...base, hotspotPercentile: 0 };
    expect(exposureFor({ ...cold, importGraph: { state: 'orphan', fanIn: 0 } })).toBe(
      RISK_MODEL_V2.exposureFileRange.min,
    );
    const hot = { ...base, hotspotPercentile: 1 };
    expect(exposureFor({ ...hot, importGraph: { state: 'imported', fanIn: 40 } })).toBe(1);
  });

  it('applies when the hotspot is unknown, too', () => {
    const unknown = { ...base, hotspotPercentile: null };
    expect(exposureFor({ ...unknown, importGraph: { state: 'orphan', fanIn: 0 } })).toBeCloseTo(
      0.6,
      10,
    );
  });

  it('is NEUTRAL whenever the graph cannot say', () => {
    // A capped snapshot, an unindexed language, an entry point, a possible
    // alias, a file the graph never saw, no graph at all: none is evidence of
    // low exposure, so none may discount.
    for (const state of [
      'incomplete',
      'unindexed',
      'entry',
      'aliased',
      'missing',
      'absent',
    ] as const) {
      expect(exposureFor({ ...mid, importGraph: { state, fanIn: null } })).toBe(xMid);
      expect(importGraphMultiplier({ state, fanIn: 0 })).toBe(1);
    }
  });

  it('leaves dependency and repo-scoped findings alone', () => {
    const dep: PricingInput = { ...base, dimension: 'dependency', depScope: { kind: 'dev' } };
    expect(exposureFor({ ...dep, importGraph: { state: 'orphan', fanIn: 0 } })).toBe(
      exposureFor(dep),
    );
    expect(
      exposureFor({ ...base, repoScoped: true, importGraph: { state: 'orphan', fanIn: 0 } }),
    ).toBe(1);
  });

  it('is ignored by the v1 constants, which had no graph factor', () => {
    const orphan = { ...mid, importGraph: { state: 'orphan' as const, fanIn: 0 } };
    expect(exposureFor(orphan, RISK_MODEL_V1)).toBe(exposureFor(mid, RISK_MODEL_V1));
    expect(priceFinding(orphan, RISK_MODEL_V1).riskFactors.model_version).toBe('risk_model.v1');
  });

  it('explains itself in risk_factors, and the score still reproduces', () => {
    const many = priceFinding({ ...mid, importGraph: { state: 'imported', fanIn: 14 } });
    expect(many.riskFactors.inputs).toMatchObject({
      import_graph: 'imported',
      import_fan_in: 14,
      exposure_why: 'imported by 14 modules',
    });
    expect(recomputeFromFactors(many.riskFactors)).toBe(many.effectiveRisk);

    const none = priceFinding({ ...mid, importGraph: { state: 'orphan', fanIn: 0 } });
    expect(none.riskFactors.inputs['exposure_why']).toBe('nothing imports this file');
    expect(none.riskFactors.inputs['import_multiplier']).toBe(0.6);
    expect(none.effectiveRisk).toBeLessThan(many.effectiveRisk);

    const capped = priceFinding({ ...mid, importGraph: { state: 'incomplete', fanIn: null } });
    expect(capped.riskFactors.inputs['exposure_why']).toMatch(/incomplete.*not adjusted/);
    expect(capped.riskFactors.inputs['import_multiplier']).toBe(1);

    // Not looked up at all: the rows are present and null, never omitted.
    expect(priceFinding(mid).riskFactors.inputs).toMatchObject({
      import_graph: null,
      exposure_why: null,
    });
  });
});
