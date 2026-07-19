import type { Database } from '@repopulse/shared';
import { computeChurn } from '../metrics/churn.js';
import { computeHotspots } from '../metrics/hotspots.js';
import { computeOwnership } from '../metrics/ownership.js';
import { computeCycleStagePercentiles } from '../metrics/cycle.js';
import { computeReviewCoverage } from '../metrics/review-coverage.js';
import { computePrSizeDistribution } from '../metrics/pr-size.js';
import { computeStalePrs } from '../metrics/stale-prs.js';
import { computeCiPassRate } from '../metrics/ci.js';
import { computeIssueThroughput } from '../metrics/issues.js';
import { computeReleaseCadence } from '../metrics/releases.js';
import { computeDeploymentFrequency } from '../metrics/dora.js';
import { writeMetricSnapshot } from './writer.js';
import {
  readChurnTouches,
  readCiRuns,
  readCyclePrs,
  readDoraInputs,
  readIssues,
  readPrSizeInputs,
  readReleaseInputs,
  readReviewCoveragePrs,
  readStalePrs,
} from './readers.js';

// The nightly metrics.snapshot compute driver (W3-10, FR-METRICS-13). For one
// repo, computes M1..M12 for every window and writes one snapshot row per
// metric × window (value + numerator/denominator for ratios + dims). Reuses the
// pure W3-02..W3-09 metric functions over the warehouse readers. Idempotent-safe
// to re-run (append-only snapshots — two nightly runs = two rows, by design).

export interface SnapshotWindow {
  key: string; // '7d' | '30d' | '90d' | '365d'
  days: number;
}

export const DEFAULT_WINDOWS: SnapshotWindow[] = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: '365d', days: 365 },
];

export interface ComputeSnapshotParams {
  workspaceId: number;
  repoId: number;
  asOf: Date;
  windows?: SnapshotWindow[];
  botGlobs?: readonly string[];
  staleThresholdDays?: number;
}

interface Reduced {
  value: number;
  numerator?: number | null;
  denominator?: number | null;
  dims?: Record<string, unknown>;
}

async function writeOne(
  db: Database,
  base: { workspaceId: number; repoId: number },
  metricKey: string,
  window: string,
  r: Reduced,
): Promise<void> {
  await writeMetricSnapshot(db, {
    workspaceId: base.workspaceId,
    repoId: base.repoId,
    metricKey,
    window,
    value: r.value,
    numerator: r.numerator ?? null,
    denominator: r.denominator ?? null,
    ...(r.dims ? { dims: r.dims } : {}),
  });
}

/**
 * Compute + snapshot every metric × window for one repo. Returns the number of
 * snapshot rows written (12 metrics × N windows).
 */
export async function computeRepoSnapshots(
  db: Database,
  params: ComputeSnapshotParams,
): Promise<number> {
  const windows = params.windows ?? DEFAULT_WINDOWS;
  const { asOf, botGlobs } = params;
  const base = { workspaceId: params.workspaceId, repoId: params.repoId };
  let written = 0;

  for (const w of windows) {
    const windowStart = new Date(asOf.getTime() - w.days * 24 * 60 * 60 * 1000);

    // --- churn family (one read → M1/M2/M3) ---
    const touches = await readChurnTouches(db, params.repoId, windowStart);
    const churn = computeChurn(touches, botGlobs);
    const hotspots = computeHotspots(touches, asOf, botGlobs);
    const ownership = computeOwnership(touches, asOf, botGlobs);

    // --- PR family (shared read → M4/M5/M6/M7/M8) ---
    const reviewPrs = await readReviewCoveragePrs(db, params.repoId, windowStart);
    const cyclePrs = await readCyclePrs(db, params.repoId, windowStart);
    const sizeInputs = await readPrSizeInputs(db, params.repoId, windowStart);
    const stalePrs = await readStalePrs(db, params.repoId);
    const coverage = computeReviewCoverage(reviewPrs);
    const cycle = computeCycleStagePercentiles(cyclePrs);
    const prSize = computePrSizeDistribution(sizeInputs);
    const stale = computeStalePrs(stalePrs, asOf, params.staleThresholdDays);

    // --- CI / issues / releases / dora ---
    const ci = computeCiPassRate(await readCiRuns(db, params.repoId, windowStart));
    const issues = computeIssueThroughput(await readIssues(db, params.repoId), windowStart, asOf);
    const release = computeReleaseCadence(
      await readReleaseInputs(db, params.repoId),
      [],
      windowStart,
      asOf,
    );
    const dora = await readDoraInputs(db, params.repoId);
    const deployFreq = computeDeploymentFrequency(
      dora.deployments,
      dora.releases,
      windowStart,
      asOf,
    );

    const rows: [string, Reduced][] = [
      ['M1', { value: churn.gross, dims: { net: churn.net, rework: churn.rework } }],
      ['M2', { value: hotspots[0]?.score ?? 0, dims: { count: hotspots.length } }],
      [
        'M3',
        {
          value: ownership.busFactor,
          dims: { topShare: ownership.topShare, singleOwner: ownership.singleOwner },
        },
      ],
      ['M4', { value: cycle.e2e.median ?? 0, dims: { p90: cycle.e2e.p90, stages: cycle } }],
      [
        'M5',
        { value: coverage.m5 ?? 0, numerator: coverage.covered, denominator: coverage.merged },
      ],
      [
        'M6',
        {
          value: coverage.m6 ?? 0,
          numerator: coverage.merged - coverage.covered,
          denominator: coverage.merged,
        },
      ],
      ['M7', { value: prSize.medianGross ?? 0, dims: { counts: prSize.counts } }],
      ['M8', { value: stale.staleCount, dims: { staleDraftCount: stale.staleDraftCount } }],
      [
        'M9',
        ((): Reduced => {
          // passRate is a ratio — recover numerator/denominator alongside value.
          return { value: ci ?? 0, numerator: null, denominator: null, dims: { passRate: ci } };
        })(),
      ],
      [
        'M10',
        {
          value: issues.closed,
          dims: { opened: issues.opened, medianTimeToCloseDays: issues.medianTimeToCloseDays },
        },
      ],
      [
        'M11',
        {
          value: release.releasesInWindow,
          dims: {
            basis: release.basis,
            medianGapDays: release.medianGapDays,
            daysSinceLast: release.daysSinceLast,
          },
        },
      ],
      [
        'M12',
        {
          value: deployFreq.countInWindow,
          dims: { basis: deployFreq.basis, caveat: deployFreq.caveat },
        },
      ],
    ];

    for (const [key, reduced] of rows) {
      await writeOne(db, base, key, w.key, reduced);
      written++;
    }
  }
  return written;
}
