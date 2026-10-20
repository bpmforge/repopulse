import { and, desc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm';
import { core, read, type Database } from '@repopulse/shared';
import { HEALTH_BAND_LABEL, healthBand } from '@repopulse/shared/health-band';
import type { ReportSection } from '../types/index.js';
import { severityWord } from './security-posture.js';

// The risk opener (W9-12, RISK_MODEL.md §5, FR-RISK-6).
//
// Every report opens with the same question a reader actually has: what should
// we do first, and what changed since last time. MOVEMENT is the half that
// makes the section worth reading twice — a top-5 that looks identical every
// month teaches people to skip the first page.
//
// Both halves resolve AT THE PIN. A report regenerated next week must show the
// same openers it showed today, or the movement line is describing a comparison
// nobody made.

export interface RiskSectionParams {
  workspaceId: number;
  repoIds: number[];
  snapshotAt: Date;
  /** The previous same-scope report's pin. Null on a first report. */
  previousSnapshotAt: Date | null;
}

const TOP_N = 5;

export async function riskSections(
  db: Database,
  params: RiskSectionParams,
): Promise<ReportSection[]> {
  const sections: ReportSection[] = [];

  const scope = [
    eq(read.findings.workspaceId, params.workspaceId),
    inArray(read.findings.status, ['open', 'confirmed']),
    // Shadow-rule findings never appear in a report (W9-07): a document sent
    // to an auditor must not carry findings from a rule still being trialled.
    eq(read.findings.experimental, false),
    lte(read.findings.firstSeenAt, params.snapshotAt),
    ...(params.repoIds.length > 0 ? [inArray(read.findings.repoId, params.repoIds)] : []),
  ];

  const repos = await db
    .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
    .from(core.repos)
    .where(eq(core.repos.workspaceId, params.workspaceId));
  const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

  const top = await db
    .select({
      id: read.findings.id,
      repoId: read.findings.repoId,
      dimension: read.findings.dimension,
      severity: read.findings.severity,
      title: read.findings.title,
      file: read.findings.file,
      effectiveRisk: read.findings.effectiveRisk,
      riskBand: read.findings.riskBand,
    })
    .from(read.findings)
    .where(and(...scope, isNotNull(read.findings.effectiveRisk)))
    .orderBy(desc(read.findings.effectiveRisk), desc(read.findings.id))
    .limit(TOP_N);

  const all = await db
    .select({ riskBand: read.findings.riskBand, effectiveRisk: read.findings.effectiveRisk })
    .from(read.findings)
    .where(and(...scope));

  const counts = {
    open: all.length,
    act: all.filter((f) => f.riskBand === 'act').length,
    schedule: all.filter((f) => f.riskBand === 'schedule').length,
    track: all.filter((f) => f.riskBand === 'track').length,
    unpriced: all.filter((f) => f.effectiveRisk === null).length,
  };

  sections.push(
    top.length > 0
      ? {
          kind: 'table',
          id: 'top_risks',
          // Band AND raw severity, both in the PDF: the composite never
          // appears without the number a reader already understands.
          columns: ['Band', 'Risk', 'Severity', 'Finding', 'Where', 'Finding #'],
          // W20-15 (UX_TODO X-23): the id, linked back to the finding.
          findingIdColumn: 5,
          rows: top.map((f) => [
            f.riskBand ?? 'not priced',
            f.effectiveRisk === null ? null : Number(f.effectiveRisk),
            severityWord(f.severity),
            f.title,
            `${repoName.get(f.repoId) ?? f.repoId}${f.file ? ` · ${f.file}` : ''}`,
            f.id,
          ]),
        }
      : {
          kind: 'no_data',
          id: 'top_risks',
          reason:
            'No priced findings at this snapshot. Findings are priced by the nightly job, so an empty opener means nothing has been scanned or nothing has been priced yet — it is not a statement that there is no risk.',
        },
  );

  // The denominator, in its own section so it cannot be cropped away from the
  // table above: "200 open → 12 act" is the credibility story.
  sections.push({
    kind: 'summary',
    id: 'risk_counts',
    markdown:
      `**${counts.open} open findings** → ${counts.act} act · ${counts.schedule} schedule · ` +
      `${counts.track} track` +
      (counts.unpriced > 0
        ? ` · ${counts.unpriced} not yet priced (the nightly job has not reached them; they are not judged low-risk)`
        : '') +
      '\n\nBands are thresholds on a computed score, not a human judgement: `act` is ' +
      'the top band or an override (known-exploited CVE, verified credential, attack chain, ' +
      'compound cluster). Raw severity is shown beside every score.',
  });

  sections.push(await movementSection(db, params, scope));

  // Data attribution (W10-02/W10-05, Law 2). endoflife.date is MIT-licensed
  // and asks to be named; a report that quotes an EOL date without saying
  // where it came from is a date the reader cannot check.
  if (top.some((f) => f.dimension === 'dependency_health')) {
    sections.push({
      kind: 'summary',
      id: 'risk_sources',
      markdown:
        'Supply-chain findings draw on public registry metadata (npm, PyPI) and ' +
        'end-of-life dates from [endoflife.date](https://endoflife.date) (MIT).',
    });
  }

  return sections;
}

/**
 * What changed since the previous same-scope report.
 *
 * Read from finding_events between the two pins — the same mechanism the plans
 * movement section uses, and for the same reason: the events are what the
 * product recorded at the time, so the comparison is reproducible rather than
 * recomputed from today's data against a remembered number.
 */
async function movementSection(
  db: Database,
  params: RiskSectionParams,
  scope: ReturnType<typeof eq>[],
): Promise<ReportSection> {
  if (!params.previousSnapshotAt) {
    return {
      kind: 'no_data',
      id: 'risk_movement',
      reason:
        'This is the first report for this scope, so there is nothing to compare against. Movement appears from the second report onwards.',
    };
  }

  const events = await db
    .select({
      findingId: read.findingEvents.findingId,
      reason: read.findingEvents.reason,
      at: read.findingEvents.at,
    })
    .from(read.findingEvents)
    .where(
      and(
        eq(read.findingEvents.workspaceId, params.workspaceId),
        gt(read.findingEvents.at, params.previousSnapshotAt),
        lte(read.findingEvents.at, params.snapshotAt),
      ),
    )
    .orderBy(desc(read.findingEvents.at))
    .limit(500);

  const repriced = events.filter((e) => e.reason?.startsWith('reprice:'));
  const intoAct = repriced.filter((e) => e.reason?.includes('→ act'));
  const outOfAct = repriced.filter((e) => /→ (schedule|track)/.test(e.reason ?? ''));

  const newFindings = await db
    .select({ id: read.findings.id })
    .from(read.findings)
    .where(and(...scope, gt(read.findings.firstSeenAt, params.previousSnapshotAt)));

  if (repriced.length === 0 && newFindings.length === 0) {
    return {
      kind: 'no_data',
      id: 'risk_movement',
      reason:
        'Nothing crossed a risk band and no new findings appeared since the previous report. That is a real result, not a missing section — the same set of risks is still open.',
    };
  }

  return {
    kind: 'table',
    id: 'risk_movement',
    columns: ['Movement', 'Count', 'Meaning'],
    rows: [
      [
        'Climbed into act',
        intoAct.length,
        'Re-priced upward — usually a file getting hotter, a rule proving accurate, or new exploit data.',
      ],
      [
        'Dropped out of act',
        outOfAct.length,
        'Re-priced downward. The finding is still open; only its ranking changed.',
      ],
      ['New findings', newFindings.length, 'First seen since the previous report at this scope.'],
    ],
  };
}

/**
 * Risk axes for the report header (RISK_MODEL §4).
 *
 * Takes the sub-scores the caller already computed rather than deriving
 * anything: a score computed here would be a second scoring system with the
 * same name as the first. An ABSENT sub-score produces an absent axis with a
 * basis line — never a grade nobody measured (FR-INSIGHTS-3).
 *
 * W20-12: each axis prints its 0–100 score and the health band word, as the
 * dashboard has since W20-09 — never an A–E letter (N-9 "signals, not
 * grades"; RISK_MODEL §4 presentation note).
 */
export function axisSection(
  subScores: readonly { key: string; normalized: number }[],
): ReportSection {
  const AXES: { key: string; label: string }[] = [
    { key: 'security', label: 'Security' },
    { key: 'codeHealth', label: 'Code Health' },
    // W10-05. Its own axis because its inputs come from outside the repo — a
    // registry and an EOL calendar — and it moves on days nobody committed.
    { key: 'supplyChain', label: 'Supply Chain' },
    { key: 'reviewHygiene', label: 'Review' },
    { key: 'ciHealth', label: 'CI' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'activity', label: 'Activity' },
  ];

  const present = AXES.map((axis) => ({
    axis,
    sub: subScores.find((s) => s.key === axis.key),
  }));

  const scored = present.filter((p) => p.sub !== undefined);
  if (scored.length === 0) {
    return {
      kind: 'no_data',
      id: 'risk_axes',
      reason:
        'No sub-score could be computed for this scope, so no axis scores are shown. A score here would be a grade nobody measured.',
    };
  }

  return {
    kind: 'table',
    id: 'risk_axes',
    columns: ['Axis', 'Score', 'Band', 'Basis'],
    rows: present.map((p) => [
      p.axis.label,
      p.sub ? Math.round(p.sub.normalized) : null,
      p.sub ? HEALTH_BAND_LABEL[healthBand(Math.round(p.sub.normalized))] : '—',
      // The absent case says WHY rather than showing a dash and leaving the
      // reader to guess whether it is bad or unmeasured.
      p.sub ? 'scored' : 'not measured for this scope — no inputs available',
    ]),
  };
}
