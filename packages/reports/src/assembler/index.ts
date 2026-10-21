import { METRIC_CATALOG, type MetricCatalogEntry } from '@repopulse/metrics';
import {
  buildHealthSubScores,
  computeHealthScore,
  healthInputsFromSnapshots,
  securityInputsMany,
  type SecurityInputs,
} from '@repopulse/insights';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { HEALTH_BAND_LABEL, healthBand } from '@repopulse/shared/health-band';
import type {
  ReportAssembler,
  ReportData,
  ReportDataQuality,
  ReportParams,
  ReportSection,
  ScoreBreakdownRow,
} from '../types/index.js';
import { readReportRepos, readSnapshotsAsOf, type BoundedSnapshot } from './read.js';
import { planSections } from './plans.js';
import { securityPostureSections, severityWord } from './security-posture.js';
import { codeHealthSections } from './code-health.js';
import { axisSection, riskSections } from './risk.js';
import { readPreviousSnapshotAt } from './previous.js';
import { aiGovernanceSections } from './ai-governance.js';

// Report assembler (W5-03, REPORTS.md §1/§2/§5/§6).
//
// Two properties matter more than the content:
//
// 1. DETERMINISM. Every read is bounded by params.snapshotAt, so identical
//    ReportParams produce identical ReportData. A report is evidence in a
//    conversation about someone's team; one that quietly changes when
//    regenerated is worse than no report.
//
// 2. NO BLANK SECTIONS (FR-REPORTS-2). Every section either has content or is
//    an explicit `no_data` with a reason. A blank section reads as a broken
//    renderer, and "no findings" and "nothing has analysed this repo" look
//    identical when both render as nothing.

const HOUR_MS = 60 * 60 * 1000;

/** Metrics each report type needs. Read once, per repo, bounded by the pin. */
const HEALTH_KEYS = ['M4', 'M5', 'M8', 'M9', 'M11'];
const HOTSPOT_KEYS = ['M2'];
const FLOW_KEYS = ['M4', 'M5', 'M6', 'M7', 'M8'];
const CI_KEYS = ['M9'];
const DORA_KEYS = ['M12', 'M11', 'M4'];
const THROUGHPUT_KEYS = ['M10', 'M4'];

const windowOf = (p: ReportParams): string => `${p.windowDays}d`;
const snap = (m: Map<string, BoundedSnapshot>, repoId: number, key: string) =>
  m.get(`${repoId}:${key}`);

function dimNum(dims: Record<string, unknown>, path: string[]): number | null {
  let cur: unknown = dims;
  for (const k of path) {
    if (cur && typeof cur === 'object' && k in cur) cur = (cur as Record<string, unknown>)[k];
    else return null;
  }
  return typeof cur === 'number' ? cur : null;
}

/** Rounds for presentation only — never for a stored number. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A 0-1 ratio as a percentage for print; null stays null. */
const pct = (n: number | null | undefined): number | null =>
  typeof n === 'number' ? Math.round(n * 1000) / 10 : null;

/** M7's buckets (METRICS.md §1 M7), in size order, with their line ranges. */
const PR_SIZE_BUCKETS: [string, string][] = [
  ['XS', 'under 10 lines'],
  ['S', '10–99 lines'],
  ['M', '100–499 lines'],
  ['L', '500–999 lines'],
  ['XL', '1,000 lines or more'],
];

/**
 * The PR flow table (W20-22, UX_TODO ADM-73): [measure, value, unit] rows,
 * leaving out any measure with no value. Exported for its test.
 */
export function flowTableRows(input: {
  m4: Record<string, unknown> | undefined;
  m5: number | null;
  m6: number | null;
  m7: { median: number | null; dims: Record<string, unknown> } | null;
  m8: number | null;
}): unknown[][] {
  const rows: unknown[][] = [];
  const push = (label: string, value: number | null, unit: string) => {
    if (value !== null && Number.isFinite(value)) rows.push([label, r2(value), unit]);
  };
  const stage = (key: string, stat: 'median' | 'p90') =>
    input.m4 ? dimNum(input.m4, ['stages', key, stat]) : null;
  push('Cycle time, open to merge (median)', stage('e2e', 'median'), 'hours');
  push('Cycle time, open to merge (90th percentile)', stage('e2e', 'p90'), 'hours');
  push('Open to first review (median)', stage('openToFirstReview', 'median'), 'hours');
  push('First review to approval (median)', stage('firstReviewToApproved', 'median'), 'hours');
  push('Approval to merge (median)', stage('approvedToMerged', 'median'), 'hours');
  push('Review coverage of merged PRs', pct(input.m5), '%');
  push('Merged without review', pct(input.m6), '%');
  if (input.m7) {
    push('PR size (median)', input.m7.median, 'lines changed');
    for (const [bucket, range] of PR_SIZE_BUCKETS) {
      push(`PRs sized ${bucket} (${range})`, dimNum(input.m7.dims, ['counts', bucket]), 'PRs');
    }
  }
  push('Stale open PRs', input.m8, 'PRs');
  return rows;
}

/** The CI table (W20-22, UX_TODO ADM-73), units named. Exported for its test. */
export function ciTableRows(value: number | null, dims: Record<string, unknown>): unknown[][] {
  const flaky = dimNum(dims, ['topFlakiness']);
  return [
    ['Default-branch pass rate', pct(value), '%'],
    ['PR pass rate', pct(dimNum(dims, ['prPassRate'])), '%'],
    ['Run duration (median)', dimNum(dims, ['duration', 'median']), 'minutes'],
    ['Run duration (90th percentile)', dimNum(dims, ['duration', 'p90']), 'minutes'],
    ['Worst workflow flakiness (fail-then-pass reruns)', pct(flaky), '% of rerun groups'],
  ].map(([label, v, unit]) => [label, typeof v === 'number' ? r2(v) : null, unit]);
}

function noData(id: string, reason: string): ReportSection {
  return { kind: 'no_data', id, reason };
}

export function createReportAssembler(db: Database): ReportAssembler {
  async function common(params: ReportParams) {
    const workspaceId = Number(params.workspaceId);
    const repoIds = params.repoIds.map(Number).filter(Number.isInteger);
    const snapshotAt = new Date(params.snapshotAt);
    const windowEnd = new Date(params.windowEnd);
    const repos = await readReportRepos(db, workspaceId, repoIds);
    // Resolved ids, so an all-repos report reads snapshots for the repos it
    // actually covers rather than passing an empty IN list downstream.
    const scopedIds = repoIds.length > 0 ? repoIds : repos.map((r) => r.id);
    return {
      workspaceId,
      repoIds: scopedIds,
      snapshotAt,
      windowEnd,
      repos,
      window: windowOf(params),
    };
  }

  /**
   * The Basis box (§5.2). `partial` is true when a repo has not finished
   * backfilling: its numbers describe less history than the window claims, and
   * a report that presents them beside a fully-backfilled repo without saying
   * so is comparing two different things.
   */
  function dataQuality(
    repos: { id: number; org: string; name: string; syncStatus: string }[],
    snapshots: Map<string, BoundedSnapshot>,
    windowEnd: Date,
  ): ReportDataQuality[] {
    return repos.map((repo) => {
      const newest = [...snapshots.values()]
        .filter((s) => s.repoId === repo.id)
        .reduce<Date | null>(
          (acc, s) => (acc === null || s.computedAt > acc ? s.computedAt : acc),
          null,
        );
      return {
        repoId: String(repo.id),
        repoName: `${repo.org}/${repo.name}`,
        phase: repo.syncStatus,
        partial: repo.syncStatus !== 'live',
        syncLagHours:
          newest === null ? null : r2((windowEnd.getTime() - newest.getTime()) / HOUR_MS),
      };
    });
  }

  /**
   * Everything the score needs beyond the snapshots (W20-09, UX_TODO
   * ADM-71/DSH-73): the pinned weights, and the Security sub-score's inputs
   * read through the same function the dashboard uses, bounded by the pin.
   */
  interface ScoreContext {
    weights: Record<string, number> | undefined;
    security: Map<number, SecurityInputs>;
  }

  async function scoreContext(
    params: ReportParams,
    workspaceId: number,
    repoIds: number[],
    snapshotAt: Date,
  ): Promise<ScoreContext> {
    return {
      weights: params.healthWeights,
      security: await securityInputsMany(db, workspaceId, repoIds, snapshotAt),
    };
  }

  function breakdownRows(
    snapshots: Map<string, BoundedSnapshot>,
    repo: { id: number; pushedAt: Date | null },
    windowEnd: Date,
    ctx: ScoreContext,
  ): {
    rows: ScoreBreakdownRow[];
    score: number;
    /** The health band's word ("healthy" / "watch" / "needs attention"). */
    band: string;
    tier1Only: boolean;
    subScores: { key: string; normalized: number }[];
  } {
    const inputs = healthInputsFromSnapshots(
      {
        M4: snap(snapshots, repo.id, 'M4') ?? { value: null, dims: {} },
        M5: snap(snapshots, repo.id, 'M5') ?? { value: null, dims: {} },
        M8: snap(snapshots, repo.id, 'M8') ?? { value: null, dims: {} },
        M9: snap(snapshots, repo.id, 'M9') ?? { value: null, dims: {} },
        M11: snap(snapshots, repo.id, 'M11') ?? { value: null, dims: {} },
      },
      // windowEnd, NOT Date.now(): "days since last push" is measured from the
      // pinned end of the window, or the same params would score differently
      // tomorrow.
      { pushedAt: repo.pushedAt, nowMs: windowEnd.getTime() },
      {
        openFindingDensity: ctx.security.get(repo.id)?.openFindingDensity ?? null,
        worstOpenSeverity: ctx.security.get(repo.id)?.worstOpenSeverity ?? null,
      },
    );
    // The PINNED weights, as Overview passes the saved ones (ADM-71).
    // buildHealthSubScores falls back per key to the defaults, which is also
    // what a report stored before the pin existed was generated under.
    const score = computeHealthScore(buildHealthSubScores(inputs, ctx.weights));
    const rows: ScoreBreakdownRow[] = [];
    for (const sub of score.subScores) {
      for (const input of sub.inputs) {
        rows.push({
          subScore: sub.key,
          input: input.key,
          rawValue: input.raw === null ? null : r2(input.raw),
          normalized: input.normalized === null ? null : r2(input.normalized),
          weight: r2(sub.weight),
          // PER INPUT, not the sub-score's total repeated on every row (W16-22).
          //
          // It used to write `sub.contribution` here, so a report showed
          // `ciHealth · topFlakiness · normalized 0 · contribution 9.29` — an
          // input that scored zero credited with 9.29 — and summing the column
          // gave 46.8 against a stated score of 38. In a document whose whole
          // design invites the reader to check the arithmetic, that is the one
          // number that must not be wrong.
          //
          // The decomposition is exact rather than invented: a sub-score is the
          // EQUAL-WEIGHT MEAN of its available inputs' ramps
          // (packages/insights/src/score/health.ts:4), so each input carries
          // normalized ÷ n of it, and the parts sum to sub.contribution.
          contribution: r2((input.normalized / sub.inputs.length) * sub.weight),
        });
      }
    }
    return {
      rows,
      score: Math.round(score.score),
      // W20-12: the band WORD, not scoreLetter's A–E. The dashboard dropped
      // letters in W20-09 (N-9 "signals, not grades"); a PDF printing "B" for
      // the same repository the web calls "watch 72" was the last remainder.
      band: HEALTH_BAND_LABEL[healthBand(Math.round(score.score))],
      tier1Only: score.renormalized,
      // W10-05: carried out so the report can print the AXIS SCORES from the
      // same sub-scores this breakdown was built from. axisSection existed
      // since W9-12 and nothing called it — the letters were in the design and
      // in a unit test, and in no report anyone received.
      subScores: score.subScores.map((sub) => ({ key: sub.key, normalized: sub.normalized })),
    };
  }

  async function repoHealthReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt, windowEnd, repos, window } = await common(params);
    if (repos.length === 0) {
      return [
        noData('repo', 'No repository in scope — it may have been removed from the workspace.'),
      ];
    }
    const repo = repos[0]!;
    const snapshots = await readSnapshotsAsOf(db, {
      workspaceId,
      repoIds,
      metricKeys: [...new Set([...HEALTH_KEYS, ...HOTSPOT_KEYS, ...FLOW_KEYS, ...CI_KEYS])],
      window,
      snapshotAt,
    });

    const health = breakdownRows(
      snapshots,
      repo,
      windowEnd,
      await scoreContext(params, workspaceId, [repo.id], snapshotAt),
    );
    const sections: ReportSection[] = [
      {
        kind: 'summary',
        markdown:
          `**${repo.org}/${repo.name}** scored **${health.score} of 100 (${health.band})** over the ` +
          `last ${params.windowDays} days.` +
          (health.tier1Only
            ? '\n\nBasis: **Tier-1 only** — sub-scores with no data were excluded and the remaining weights renormalized.'
            : ''),
      },
    ];

    sections.push(
      health.rows.length > 0
        ? { kind: 'score_breakdown', rows: health.rows }
        : noData(
            'score_breakdown',
            'No health-input metrics have been computed for this repository yet.',
          ),
    );

    // W10-05: the risk axes, from the sub-scores above. An axis with no
    // sub-score prints "not measured" rather than a grade (FR-INSIGHTS-3).
    sections.push(axisSection(health.subScores));

    // Hotspots (M2) — the dims carry the ranked file list.
    const m2 = snap(snapshots, repo.id, 'M2');
    const files = Array.isArray(m2?.dims.files) ? (m2.dims.files as Record<string, unknown>[]) : [];
    sections.push(
      files.length > 0
        ? {
            kind: 'table',
            id: 'hotspots',
            columns: ['File', 'Hotspot score', 'Gross churn', 'Last touched'],
            rows: files
              .slice(0, 10)
              .map((f) => [f.path, f.score, f.gross ?? null, f.lastTouchedAt ?? null]),
          }
        : noData(
            'hotspots',
            'No hotspot snapshot for this window — the repository may have no commits in it.',
          ),
    );

    // PR flow (M4 stages, M5 coverage, M6 bypass, M7 size, M8 stale).
    //
    // W20-22 (UX_TODO ADM-73): one row per thing measured, named in words with
    // its unit beside it. It printed "M4 · PR cycle-time stages · 41.2": an
    // internal id, no stage, no unit, and coverage as 0.83 rather than 83 %.
    // The value cell stays a NUMBER so the report diff still reads a delta.
    const m4 = snap(snapshots, repo.id, 'M4');
    const m5 = snap(snapshots, repo.id, 'M5');
    const m6 = snap(snapshots, repo.id, 'M6');
    const m7 = snap(snapshots, repo.id, 'M7');
    const m8 = snap(snapshots, repo.id, 'M8');
    const flowRows = flowTableRows({
      m4: m4?.dims,
      m5: m5?.value ?? null,
      m6: m6?.value ?? null,
      m7: m7 ? { median: m7.value, dims: m7.dims } : null,
      m8: m8?.value ?? null,
    });
    sections.push(
      flowRows.length > 0
        ? { kind: 'table', id: 'pr_flow', columns: ['Measure', 'Value', 'Unit'], rows: flowRows }
        : noData('pr_flow', 'No pull-request metrics in this window.'),
    );

    // CI (M9): pass rate, duration and flakiness are separate dims (W4-15).
    const m9 = snap(snapshots, repo.id, 'M9');
    sections.push(
      m9
        ? {
            kind: 'table',
            id: 'ci',
            columns: ['Measure', 'Value', 'Unit'],
            rows: ciTableRows(m9.value, m9.dims),
          }
        : noData('ci', 'No CI runs ingested for this repository in this window.'),
    );

    // THIS REPOSITORY'S FINDINGS (W16-54).
    //
    // The section was an unconditional no_data block reading "findings require
    // the analysis pass (W6)" — no query behind it, waves after W6 shipped. The
    // same report opens by counting them: a reader saw "3 open findings" on the
    // first page and "no analysis data" on the last. Nothing here is Tier-1
    // only; the sentence had simply outlived its wave.
    //
    // OPEN findings only, at the pin (W20-15, UX_TODO X-22): the query had no
    // status filter, no shadow-rule filter and no snapshot bound, so dismissed
    // false positives, resolved and trial-rule findings pushed open ones out of
    // a document sent to others, and a re-print picked up findings raised
    // after the pin. Same scope as the risk opener.
    const openFindings = await db
      .select({
        id: read.findings.id,
        severity: read.findings.severity,
        dimension: read.findings.dimension,
        title: read.findings.title,
        file: read.findings.file,
        lineStart: read.findings.lineStart,
        status: read.findings.status,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.repoId, repo.id),
          inArray(read.findings.status, ['open', 'confirmed']),
          eq(read.findings.experimental, false),
          lte(read.findings.firstSeenAt, snapshotAt),
        ),
      )
      .orderBy(desc(read.findings.severity), desc(read.findings.id))
      .limit(25);
    sections.push(
      openFindings.length > 0
        ? {
            kind: 'table',
            id: 'findings',
            columns: ['Severity', 'Dimension', 'Finding', 'Where', 'Status', 'Finding #'],
            findingIdColumn: 5,
            rows: openFindings.map((f) => [
              severityWord(f.severity),
              f.dimension,
              f.title,
              // "whole repository" rather than a bare colon, the same words
              // the screens use (W16-40) — a repository-level finding has no
              // file and that is a real answer, not a missing one.
              f.file === null
                ? 'whole repository'
                : f.lineStart === null
                  ? f.file
                  : `${f.file}:${f.lineStart}`,
              f.status,
              f.id,
            ]),
          }
        : noData(
            'findings',
            'No open findings for this repository at this snapshot. Findings are written by the analysis and scanner passes, so an empty section means nothing has run or nothing was found — the scanner coverage table on the repository screen says which.',
          ),
    );
    return sections;
  }

  async function orgExecReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt, windowEnd, repos, window } = await common(params);
    if (repos.length === 0) return [noData('repos', 'No repositories in scope for this report.')];

    const snapshots = await readSnapshotsAsOf(db, {
      workspaceId,
      repoIds,
      metricKeys: [...new Set([...HEALTH_KEYS, ...DORA_KEYS, ...THROUGHPUT_KEYS, ...HOTSPOT_KEYS])],
      window,
      snapshotAt,
    });

    const ctx = await scoreContext(params, workspaceId, repoIds, snapshotAt);
    const perRepo = repos.map((repo) => ({
      repo,
      health: breakdownRows(snapshots, repo, windowEnd, ctx),
    }));
    const scored = perRepo.filter((p) => p.health.rows.length > 0);
    const mean =
      scored.length > 0
        ? Math.round(scored.reduce((s, p) => s + p.health.score, 0) / scored.length)
        : null;

    const sections: ReportSection[] = [
      {
        kind: 'summary',
        markdown:
          mean === null
            ? `**${repos.length} repositories** in scope; none has health-input metrics yet.`
            : `**${repos.length} repositories**, mean health **${mean}** over the last ${params.windowDays} days.`,
      },
    ];

    sections.push(
      scored.length > 0
        ? {
            kind: 'table',
            id: 'per_repo_scores',
            columns: ['Repository', 'Score', 'Band', 'Basis'],
            rows: scored.map((p) => [
              `${p.repo.org}/${p.repo.name}`,
              p.health.score,
              p.health.band,
              p.health.tier1Only ? 'Tier-1 only' : 'full',
            ]),
          }
        : noData('per_repo_scores', 'No repository has health-input metrics in this window.'),
    );

    // DORA at org level, each tile footnoted with its basis (FR-METRICS-12).
    const orgSnapshots = await readSnapshotsAsOf(db, {
      workspaceId,
      repoIds,
      metricKeys: DORA_KEYS,
      window,
      snapshotAt,
      orgLevel: true,
    });
    const m12 = orgSnapshots.get('org:M12');
    sections.push(
      m12
        ? {
            kind: 'table',
            id: 'dora',
            columns: ['Metric', 'Value', 'Basis'],
            rows: [
              [
                'Deployment frequency',
                dimNum(m12.dims, ['deployFrequency']),
                basisOf(m12.dims, 'deployFrequency'),
              ],
              ['Lead time (h)', dimNum(m12.dims, ['leadTimeHours']), basisOf(m12.dims, 'leadTime')],
              [
                'Change-failure rate',
                dimNum(m12.dims, ['changeFailureRate']),
                basisOf(m12.dims, 'changeFailureRate'),
              ],
              ['MTTR', dimNum(m12.dims, ['mttrHours']), 'needs incident data'],
            ],
          }
        : noData(
            'dora',
            'No DORA snapshot at org level for this window (FR-METRICS-12 needs releases or deployments).',
          ),
    );

    sections.push(
      noData(
        'top_risks',
        'Single-owner hotspots and review-bypass risks need the M3/M6 dims, which are not in this window’s snapshots.',
      ),
    );
    return sections;
  }

  async function securityPostureReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt, windowEnd } = await common(params);
    return securityPostureSections(db, {
      workspaceId,
      repoIds,
      snapshotAt,
      // The window START, derived from the pinned end — never Date.now(), or
      // the egress summary would silently widen every time it is regenerated.
      windowStart: new Date(windowEnd.getTime() - params.windowDays * 86_400_000),
    });
  }

  async function codeHealthReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt } = await common(params);
    return codeHealthSections(db, { workspaceId, repoIds, snapshotAt });
  }

  async function deliveryDoraReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt, window } = await common(params);
    const orgSnapshots = await readSnapshotsAsOf(db, {
      workspaceId,
      repoIds,
      metricKeys: [...new Set([...DORA_KEYS, ...THROUGHPUT_KEYS])],
      window,
      snapshotAt,
      orgLevel: true,
    });
    const m12 = orgSnapshots.get('org:M12');
    const m4 = orgSnapshots.get('org:M4');
    const m11 = orgSnapshots.get('org:M11');

    const sections: ReportSection[] = [
      {
        kind: 'summary',
        markdown:
          'DORA figures here are **heuristic approximations** (FR-METRICS-12): deployments are ' +
          'inferred from releases and merges to the default branch unless a deployment feed exists, ' +
          'and change failures from revert/hotfix heuristics. Each tile carries its own basis.',
      },
    ];

    sections.push(
      m12
        ? {
            kind: 'table',
            id: 'dora_tiles',
            columns: ['Metric', 'Value', 'Basis'],
            rows: [
              [
                'Deployment frequency',
                dimNum(m12.dims, ['deployFrequency']),
                basisOf(m12.dims, 'deployFrequency'),
              ],
              [
                'Lead time for change (h)',
                dimNum(m12.dims, ['leadTimeHours']),
                basisOf(m12.dims, 'leadTime'),
              ],
              [
                'Change-failure rate',
                dimNum(m12.dims, ['changeFailureRate']),
                basisOf(m12.dims, 'changeFailureRate'),
              ],
              // Never silently 0: no incident feed exists, and 0 would read as
              // "we always recover instantly" (FR-METRICS-12).
              ['Mean time to restore', dimNum(m12.dims, ['mttrHours']), 'needs incident data'],
            ],
          }
        : noData(
            'dora_tiles',
            'No DORA snapshot for this window — needs releases, deployments or merges to the default branch.',
          ),
    );

    sections.push(
      m4
        ? {
            kind: 'table',
            id: 'cycle_stages',
            columns: ['Stage', 'Median (h)', 'p90 (h)'],
            rows: [
              [
                'Open → first review',
                dimNum(m4.dims, ['stages', 'openToFirstReview', 'median']),
                dimNum(m4.dims, ['stages', 'openToFirstReview', 'p90']),
              ],
              [
                'First review → approval',
                dimNum(m4.dims, ['stages', 'reviewToApproval', 'median']),
                dimNum(m4.dims, ['stages', 'reviewToApproval', 'p90']),
              ],
              [
                'Approval → merge',
                dimNum(m4.dims, ['stages', 'approvalToMerge', 'median']),
                dimNum(m4.dims, ['stages', 'approvalToMerge', 'p90']),
              ],
            ],
          }
        : noData('cycle_stages', 'No pull-request cycle snapshot in this window.'),
    );

    sections.push(
      m11
        ? {
            kind: 'table',
            id: 'release_cadence',
            columns: ['Measure', 'Value'],
            rows: [
              ['Releases in window', m11.value === null ? null : r2(m11.value)],
              ['Days since last release', dimNum(m11.dims, ['daysSinceLast'])],
            ],
          }
        : noData('release_cadence', 'No releases ingested in this window.'),
    );

    sections.push(
      noData(
        'change_failure_drilldown',
        'The reverts and hotfixes behind the change-failure rate need M12 dims that this window’s snapshot does not carry.',
      ),
    );
    return sections;
  }

  /** The heuristic label a DORA tile must carry (FR-METRICS-12). */
  function basisOf(dims: Record<string, unknown>, key: string): string {
    const basis = dims.basis;
    if (basis && typeof basis === 'object' && key in basis) {
      const v = (basis as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
    // Absent basis is reported as unknown rather than assumed exact: an
    // unlabelled DORA number reads as measured when it is inferred.
    return 'heuristic (basis not recorded)';
  }

  return {
    async assemble(params: ReportParams): Promise<ReportData> {
      const sections =
        params.type === 'repo_health'
          ? await repoHealthReport(params)
          : params.type === 'org_exec'
            ? await orgExecReport(params)
            : params.type === 'delivery_dora'
              ? await deliveryDoraReport(params)
              : params.type === 'code_health'
                ? await codeHealthReport(params)
                : await securityPostureReport(params);

      const { workspaceId, repoIds, snapshotAt, windowEnd, repos, window } = await common(params);

      // Every report closes with the plan (IMPROVEMENT_PLANS.md §5). Appended
      // for every type, including security_posture: the whole point is that a
      // report ends with what was agreed, not with a list of problems.
      // W5-09: the previous same-scope report's pin, so the plan section can
      // report what MOVED rather than what is merely true now.
      const previousSnapshotAt = await readPreviousSnapshotAt(db, params);
      const planned = await planSections(db, { workspaceId, snapshotAt, previousSnapshotAt });

      // W9-12: the risk opener leads repo_health, org_exec and
      // security_posture. Not delivery_dora or code_health — those answer a
      // different question, and a top-risks table at the head of a DORA report
      // would be the product deciding what the reader came for.
      const risk =
        params.type === 'repo_health' ||
        params.type === 'org_exec' ||
        params.type === 'security_posture'
          ? await riskSections(db, { workspaceId, repoIds, snapshotAt, previousSnapshotAt })
          : [];

      // W18-20: AI-authored vs human changes, after the type's own sections and
      // before the plan. repo_health and org_exec only — the two reports a
      // leader reads to answer "what is happening to our code", which is the
      // question this section exists for.
      const governance =
        params.type === 'repo_health' || params.type === 'org_exec'
          ? await aiGovernanceSections(db, {
              workspaceId,
              repoIds,
              windowEnd,
              windowDays: params.windowDays,
            })
          : [];

      const qualitySnapshots = await readSnapshotsAsOf(db, {
        workspaceId,
        repoIds,
        metricKeys: [...new Set([...HEALTH_KEYS, ...HOTSPOT_KEYS, ...CI_KEYS])],
        window,
        snapshotAt,
      });

      return {
        params,
        sections: [...risk, ...sections, ...governance, ...planned],
        appendix: {
          // Appendix A comes from the catalog (FR-METRICS-15), never from
          // prose in this file: a definition that disagrees with the tooltip
          // the reader saw on screen is worse than no appendix.
          definitions: METRIC_CATALOG as MetricCatalogEntry[],
        },
        dataQuality: dataQuality(repos, qualitySnapshots, windowEnd),
      };
    },
  };
}
