import type { Database } from '@repopulse/shared';
import { computeChurn } from '../metrics/churn.js';
import { computeHotspots } from '../metrics/hotspots.js';
import { computeOwnership } from '../metrics/ownership.js';
import { computeCycleStagePercentiles } from '../metrics/cycle.js';
import { computeReviewCoverage } from '../metrics/review-coverage.js';
import { computePrSizeDistribution } from '../metrics/pr-size.js';
import { computeStalePrs } from '../metrics/stale-prs.js';
import { computeCiDuration, computeCiFlakiness, computeCiPassRate } from '../metrics/ci.js';

import { computeIssueThroughput } from '../metrics/issues.js';
import { computeReleaseCadence } from '../metrics/releases.js';
import { computeDeploymentFrequency } from '../metrics/dora.js';
import { writeMetricSnapshot } from './writer.js';
import { INTENT_HOTSPOT_WINDOW, recordIntentHotspotScores } from './intent-hotspots.js';
import { computeRework14d, computeRevertRate } from '../metrics/debt.js';
import {
  readChurnTouches,
  readCommitFlags,
  readCiRuns,
  readCyclePrs,
  readDoraInputs,
  readIssues,
  readPrSizeInputs,
  readReleaseInputs,
  readReviewCoveragePrs,
  readStalePrs,
} from './readers.js';

// How many workflows' flakiness rows land in M9's dims. The ranking endpoint
// reads these, and dims is a jsonb column on an append-only nightly series — a
// monorepo with hundreds of workflows would otherwise write a table's worth of
// JSON per repo per night to serve a "top offenders" list.
const FLAKINESS_TOP_N = 20;
/**
 * Per-file M2 scores kept on each snapshot (W20-13), highest first. Enough for
 * the file page and the risk percentile; a monorepo with tens of thousands of
 * touched files would otherwise write that much JSON on every run.
 */
const HOTSPOT_FILES_KEPT = 500;

// The nightly metrics.snapshot compute driver (W3-10, FR-METRICS-13). For one
// repo, computes M1..M12 for every window and writes one snapshot row per
// metric × window (value + numerator/denominator for ratios + dims). Reuses the
// pure W3-02..W3-09 metric functions over the warehouse readers. Idempotent-safe
// to re-run (append-only snapshots — two nightly runs = two rows, by design).

export interface SnapshotWindow {
  key: string; // '7d' | '14d' | '30d' | '90d' | '365d'
  days: number;
}

export const DEFAULT_WINDOWS: SnapshotWindow[] = [
  { key: '7d', days: 7 },
  // W20-16 (UX_TODO DSH-56): a two-week sprint is the period a retro asks
  // about, and it had to be read through the 30-day numbers.
  { key: '14d', days: 14 },
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
  /** null = no measurement for this window; the row is skipped (see below). */
  value: number | null;
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
    value: r.value as number,
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
    // M13/M14 (W9-05): computed from reads already in hand — the touches above
    // and the commit rows the churn read returned.
    const rework14 = computeRework14d(touches);
    const revertRate = computeRevertRate(await readCommitFlags(db, params.repoId, windowStart));
    // Highest first. computeHotspots returns paths in first-touch order, so
    // `hotspots[0]` was an arbitrary file rather than the repo's top hotspot.
    const hotspots = computeHotspots(touches, asOf, botGlobs).sort((a, b) => b.score - a.score);
    const ownership = computeOwnership(touches, asOf, botGlobs);
    // W20-24 (UX_TODO DSH-37): each intent file's score on this run, from the
    // list just computed, so "has it improved since the intent?" has a
    // history even after the file drops out of M2's top-files list.
    if (w.key === INTENT_HOTSPOT_WINDOW.key) {
      await recordIntentHotspotScores(db, {
        workspaceId: params.workspaceId,
        repoId: params.repoId,
        asOf,
        hotspots,
      });
    }

    // --- PR family (shared read → M4/M5/M6/M7/M8) ---
    const reviewPrs = await readReviewCoveragePrs(db, params.repoId, windowStart, botGlobs);
    const cyclePrs = await readCyclePrs(db, params.repoId, windowStart, botGlobs);
    const sizeInputs = await readPrSizeInputs(db, params.repoId, windowStart);
    const stalePrs = await readStalePrs(db, params.repoId);
    const coverage = computeReviewCoverage(reviewPrs);
    const cycle = computeCycleStagePercentiles(cyclePrs);
    const prSize = computePrSizeDistribution(sizeInputs);
    const stale = computeStalePrs(stalePrs, asOf, params.staleThresholdDays);

    // --- CI / issues / releases / dora ---
    // M9 has THREE components (METRICS.md §1: pass rate, duration, flakiness)
    // and only the first was ever persisted — computeCiDuration and
    // computeCiFlakiness were implemented, fixture-tested and called by nothing.
    //
    // The split is also the spec, not a refinement: §1 says "default-branch vs
    // PR runs reported separately". Every run was being pooled into one
    // passRate, which routes/org/health.ts then read as `m9PassRate` and ramped
    // under the comment "M9 default-branch passRate" — so a repo with noisy PR
    // CI was scored down for a default branch that was fine.
    const ciRuns = await readCiRuns(db, params.repoId, windowStart);
    const defaultBranchRuns = ciRuns.filter((r) => r.pullRequestId === null);
    const prRuns = ciRuns.filter((r) => r.pullRequestId !== null);
    const ci = computeCiPassRate(defaultBranchRuns);
    const ciPr = computeCiPassRate(prRuns);
    const ciDuration = computeCiDuration(defaultBranchRuns);
    const ciFlakiness = computeCiFlakiness(ciRuns);
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
      [
        'M2',
        {
          value: hotspots[0]?.score ?? 0,
          // W20-13: per-file scores, so the file page can plot the history of
          // the file being viewed (not the repo's top file) and the risk
          // repricer's within-repo percentile has the list it already reads.
          dims: {
            count: hotspots.length,
            files: hotspots.slice(0, HOTSPOT_FILES_KEPT).map((h) => ({
              path: h.path,
              score: Math.round(h.score * 1e6) / 1e6,
            })),
          },
        },
      ],
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
          // `value` stays the default-branch pass rate: it is what the health
          // score and the existing trend endpoint read, and changing the scalar
          // would silently rewrite the meaning of every historical row.
          //
          // NULL vs 0 is load-bearing throughout these dims. A repo with no
          // CI at all and a repo whose CI never passes must not look alike —
          // `passRate: null` means "no completed runs to divide by", and the
          // ramp drops a null input from its sub-score rather than scoring it
          // zero. Same for flakiness: a workflow never rerun has no flakiness
          // ratio, which is not the same as a flakiness of 0.
          return {
            value: ci ?? 0,
            numerator: null,
            denominator: null,
            dims: {
              passRate: ci,
              prPassRate: ciPr,
              defaultBranchRuns: defaultBranchRuns.length,
              prRuns: prRuns.length,
              duration: ciDuration,
              // Ranked desc by computeCiFlakiness; capped because this is a
              // jsonb column on an append-only series, not a table — the
              // ranking endpoint reads the top offenders, and a repo with 400
              // workflows must not write 400 rows' worth of dims every night.
              flakiness: ciFlakiness.slice(0, FLAKINESS_TOP_N),
              flakinessWorkflows: ciFlakiness.length,
              topFlakiness: ciFlakiness[0]?.flakinessRatio ?? null,
            },
          };
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
      // W9-06 wiring for W9-05's debt signals. They ride the SAME per-window
      // loop as everything else, from the churn read that is already in hand —
      // a separate nightly job for two numbers would be a second thing to
      // schedule, a second thing to fail, and a second place for the window
      // definition to drift.
      [
        'M13',
        {
          value: rework14.rate,
          dims: {
            reworkLines: rework14.reworkLines,
            totalLines: rework14.totalLines,
            lookbackDays: 14,
          },
        },
      ],
      [
        'M14',
        {
          value: revertRate.rate,
          dims: {
            reverts: revertRate.reverts,
            eligibleCommits: revertRate.eligibleCommits,
            heuristic: 'commit-message shape (is_revert_heuristic)',
          },
        },
      ],
    ];

    for (const [key, reduced] of rows) {
      // A NULL-valued metric writes NO ROW. metric_snapshots.value is NOT NULL
      // and storing 0 would be a lie — a 0% rework rate for a week with no
      // commits reads as a perfect week. An absent row makes the trend show a
      // GAP, which is what "we did not measure this" looks like on a chart.
      if (reduced.value === null) continue;
      await writeOne(db, base, key, w.key, reduced);
      written++;
    }
  }
  return written;
}
