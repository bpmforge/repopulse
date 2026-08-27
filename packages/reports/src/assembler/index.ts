import { METRIC_CATALOG, type MetricCatalogEntry } from '@repopulse/metrics';
import {
  buildHealthSubScores,
  computeHealthScore,
  healthInputsFromSnapshots,
  scoreLetter,
} from '@repopulse/insights';
import type { Database } from '@repopulse/shared';
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
import { securityPostureSections } from './security-posture.js';
import { codeHealthSections } from './code-health.js';
import { axisSection, riskSections } from './risk.js';
import { readPreviousSnapshotAt } from './previous.js';

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
    return { workspaceId, repoIds: scopedIds, snapshotAt, windowEnd, repos, window: windowOf(params) };
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
        .reduce<Date | null>((acc, s) => (acc === null || s.computedAt > acc ? s.computedAt : acc), null);
      return {
        repoId: String(repo.id),
        repoName: `${repo.org}/${repo.name}`,
        phase: repo.syncStatus,
        partial: repo.syncStatus !== 'live',
        syncLagHours: newest === null ? null : r2((windowEnd.getTime() - newest.getTime()) / HOUR_MS),
      };
    });
  }

  function breakdownRows(
    snapshots: Map<string, BoundedSnapshot>,
    repo: { id: number; pushedAt: Date | null },
    windowEnd: Date,
  ): {
    rows: ScoreBreakdownRow[];
    score: number;
    letter: string;
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
    );
    const score = computeHealthScore(buildHealthSubScores(inputs));
    const rows: ScoreBreakdownRow[] = [];
    for (const sub of score.subScores) {
      for (const input of sub.inputs) {
        rows.push({
          subScore: sub.key,
          input: input.key,
          rawValue: input.raw === null ? null : r2(input.raw),
          normalized: input.normalized === null ? null : r2(input.normalized),
          weight: r2(sub.weight),
          contribution: r2(sub.contribution),
        });
      }
    }
    return {
      rows,
      score: Math.round(score.score),
      letter: scoreLetter(score.score),
      tier1Only: score.renormalized,
      // W10-05: carried out so the report can print the AXIS LETTERS from the
      // same sub-scores this breakdown was built from. axisSection existed
      // since W9-12 and nothing called it — the letters were in the design and
      // in a unit test, and in no report anyone received.
      subScores: score.subScores.map((sub) => ({ key: sub.key, normalized: sub.normalized })),
    };
  }

  async function repoHealthReport(params: ReportParams): Promise<ReportSection[]> {
    const { workspaceId, repoIds, snapshotAt, windowEnd, repos, window } = await common(params);
    if (repos.length === 0) {
      return [noData('repo', 'No repository in scope — it may have been removed from the workspace.')];
    }
    const repo = repos[0]!;
    const snapshots = await readSnapshotsAsOf(db, {
      workspaceId,
      repoIds,
      metricKeys: [...new Set([...HEALTH_KEYS, ...HOTSPOT_KEYS, ...FLOW_KEYS, ...CI_KEYS])],
      window,
      snapshotAt,
    });

    const health = breakdownRows(snapshots, repo, windowEnd);
    const sections: ReportSection[] = [
      {
        kind: 'summary',
        markdown:
          `**${repo.org}/${repo.name}** scored **${health.score} (${health.letter})** over the ` +
          `last ${params.windowDays} days.` +
          (health.tier1Only
            ? '\n\nBasis: **Tier-1 only** — sub-scores with no data were excluded and the remaining weights renormalized.'
            : ''),
      },
    ];

    sections.push(
      health.rows.length > 0
        ? { kind: 'score_breakdown', rows: health.rows }
        : noData('score_breakdown', 'No health-input metrics have been computed for this repository yet.'),
    );

    // W10-05: the axis letters, from the sub-scores above. An axis with no
    // sub-score prints "not measured" rather than a grade (FR-INSIGHTS-3).
    sections.push(axisSection(health.subScores, scoreLetter));

    // Hotspots (M2) — the dims carry the ranked file list.
    const m2 = snap(snapshots, repo.id, 'M2');
    const files = Array.isArray(m2?.dims.files) ? (m2.dims.files as Record<string, unknown>[]) : [];
    sections.push(
      files.length > 0
        ? {
            kind: 'table',
            id: 'hotspots',
            columns: ['File', 'Hotspot score', 'Gross churn', 'Last touched'],
            rows: files.slice(0, 10).map((f) => [f.path, f.score, f.gross ?? null, f.lastTouchedAt ?? null]),
          }
        : noData('hotspots', 'No hotspot snapshot for this window — the repository may have no commits in it.'),
    );

    // PR flow (M4 stages, M5 coverage, M6 bypass, M7 size, M8 stale).
    const flowRows: unknown[][] = [];
    for (const key of ['M4', 'M5', 'M6', 'M7', 'M8']) {
      const s = snap(snapshots, repo.id, key);
      if (s?.value !== undefined && s.value !== null) {
        flowRows.push([key, METRIC_CATALOG.find((c) => c.id === key)?.name ?? key, r2(s.value)]);
      }
    }
    sections.push(
      flowRows.length > 0
        ? { kind: 'table', id: 'pr_flow', columns: ['Metric', 'Name', 'Value'], rows: flowRows }
        : noData('pr_flow', 'No pull-request metrics in this window.'),
    );

    // CI (M9): pass rate, duration and flakiness are separate dims (W4-15).
    const m9 = snap(snapshots, repo.id, 'M9');
    sections.push(
      m9
        ? {
            kind: 'table',
            id: 'ci',
            columns: ['Measure', 'Value'],
            rows: [
              ['Default-branch pass rate', m9.value === null ? null : r2(m9.value)],
              ['PR pass rate', dimNum(m9.dims, ['prPassRate'])],
              ['Median duration (min)', dimNum(m9.dims, ['duration', 'median'])],
              ['Worst workflow flakiness', dimNum(m9.dims, ['topFlakiness'])],
            ],
          }
        : noData('ci', 'No CI runs ingested for this repository in this window.'),
    );

    // Findings arrive in W6. Saying so beats an empty heading that looks broken.
    sections.push(
      noData('findings', 'No analysis data (Tier-1 only) — findings require the analysis pass (W6).'),
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

    const perRepo = repos.map((repo) => ({ repo, health: breakdownRows(snapshots, repo, windowEnd) }));
    const scored = perRepo.filter((p) => p.health.rows.length > 0);
    const mean =
      scored.length > 0 ? Math.round(scored.reduce((s, p) => s + p.health.score, 0) / scored.length) : null;

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
            columns: ['Repository', 'Score', 'Letter', 'Basis'],
            rows: scored.map((p) => [
              `${p.repo.org}/${p.repo.name}`,
              p.health.score,
              p.health.letter,
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
              ['Deployment frequency', dimNum(m12.dims, ['deployFrequency']), basisOf(m12.dims, 'deployFrequency')],
              ['Lead time (h)', dimNum(m12.dims, ['leadTimeHours']), basisOf(m12.dims, 'leadTime')],
              ['Change-failure rate', dimNum(m12.dims, ['changeFailureRate']), basisOf(m12.dims, 'changeFailureRate')],
              ['MTTR', dimNum(m12.dims, ['mttrHours']), 'needs incident data'],
            ],
          }
        : noData('dora', 'No DORA snapshot at org level for this window (FR-METRICS-12 needs releases or deployments).'),
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
              ['Deployment frequency', dimNum(m12.dims, ['deployFrequency']), basisOf(m12.dims, 'deployFrequency')],
              ['Lead time for change (h)', dimNum(m12.dims, ['leadTimeHours']), basisOf(m12.dims, 'leadTime')],
              ['Change-failure rate', dimNum(m12.dims, ['changeFailureRate']), basisOf(m12.dims, 'changeFailureRate')],
              // Never silently 0: no incident feed exists, and 0 would read as
              // "we always recover instantly" (FR-METRICS-12).
              ['Mean time to restore', dimNum(m12.dims, ['mttrHours']), 'needs incident data'],
            ],
          }
        : noData('dora_tiles', 'No DORA snapshot for this window — needs releases, deployments or merges to the default branch.'),
    );

    sections.push(
      m4
        ? {
            kind: 'table',
            id: 'cycle_stages',
            columns: ['Stage', 'Median (h)', 'p90 (h)'],
            rows: [
              ['Open → first review', dimNum(m4.dims, ['stages', 'openToFirstReview', 'median']), dimNum(m4.dims, ['stages', 'openToFirstReview', 'p90'])],
              ['First review → approval', dimNum(m4.dims, ['stages', 'reviewToApproval', 'median']), dimNum(m4.dims, ['stages', 'reviewToApproval', 'p90'])],
              ['Approval → merge', dimNum(m4.dims, ['stages', 'approvalToMerge', 'median']), dimNum(m4.dims, ['stages', 'approvalToMerge', 'p90'])],
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

      const qualitySnapshots = await readSnapshotsAsOf(db, {
        workspaceId,
        repoIds,
        metricKeys: [...new Set([...HEALTH_KEYS, ...HOTSPOT_KEYS, ...CI_KEYS])],
        window,
        snapshotAt,
      });

      return {
        params,
        sections: [...risk, ...sections, ...planned],
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
