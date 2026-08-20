import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { core, read, security, type Database } from '@repopulse/shared';
import type { ReportSection } from '../types/index.js';

// Code Health report (W9-06, FR-REPORTS-8, CODE_HEALTH_SUITE.md §6).
//
// It has to work in two states and say which one it is in. ENRICHED: the W9
// scanners have run and there are measurements. DEGRADED: they have not, and
// the only things available are the debt signals from ingested history (M13,
// M14). The degraded rendering is the common case for a new installation, and
// a report that hides which one it produced would let "no complexity findings"
// read as "no complex functions".

export interface CodeHealthParams {
  workspaceId: number;
  repoIds: number[];
  snapshotAt: Date;
}

const CH_KEYS = ['ch_duplication_pct', 'ch_complexity_p90', 'ch_worst_fn_count'] as const;
const DEBT_KEYS = ['M13', 'M14'] as const;

/** Latest value per metric key at or before the pin. */
async function latestByKey(
  db: Database,
  params: CodeHealthParams,
  keys: readonly string[],
): Promise<Map<string, number>> {
  const scope =
    params.repoIds.length > 0
      ? and(
          eq(read.metricSnapshots.workspaceId, params.workspaceId),
          inArray(read.metricSnapshots.repoId, params.repoIds),
        )
      : eq(read.metricSnapshots.workspaceId, params.workspaceId);

  const rows = await db
    .select({
      metricKey: read.metricSnapshots.metricKey,
      value: read.metricSnapshots.value,
      computedAt: read.metricSnapshots.computedAt,
    })
    .from(read.metricSnapshots)
    .where(
      and(
        scope,
        inArray(read.metricSnapshots.metricKey, [...keys]),
        // The pin, on the same terms as every other assembler: a snapshot
        // computed after the report was pinned did not inform it.
        lte(read.metricSnapshots.computedAt, params.snapshotAt),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt))
    .limit(500);

  const out = new Map<string, number>();
  for (const row of rows) if (!out.has(row.metricKey)) out.set(row.metricKey, Number(row.value));
  return out;
}

export async function codeHealthSections(
  db: Database,
  params: CodeHealthParams,
): Promise<ReportSection[]> {
  const sections: ReportSection[] = [];

  const repos = await db
    .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
    .from(core.repos)
    .where(eq(core.repos.workspaceId, params.workspaceId));
  const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

  const posture = await latestByKey(db, params, CH_KEYS);
  const debt = await latestByKey(db, params, DEBT_KEYS);

  const scanScope =
    params.repoIds.length > 0
      ? and(
          eq(security.scanRuns.workspaceId, params.workspaceId),
          inArray(security.scanRuns.repoId, params.repoIds),
        )
      : eq(security.scanRuns.workspaceId, params.workspaceId);

  const runs = await db
    .select()
    .from(security.scanRuns)
    .where(
      and(
        scanScope,
        inArray(security.scanRuns.scannerKey, [
          'code_health_tools',
          'anti_slop',
          'logging_hygiene',
        ]),
        lte(security.scanRuns.startedAt, params.snapshotAt),
      ),
    )
    .orderBy(desc(security.scanRuns.startedAt))
    .limit(200);

  const enriched = posture.size > 0 || runs.length > 0;

  // 1. Which rendering this is, said first rather than inferred from gaps.
  sections.push({
    kind: 'summary',
    id: 'code_health_basis',
    markdown: enriched
      ? [
          '**This report includes scanner measurements.**',
          '',
          `Complexity and duplication come from lizard and jscpd runs over a pinned commit; ` +
            `structural-slop and logging findings come from our own rulepacks. Thresholds are the ` +
            `canon defaults (duplication 5%, cyclomatic 10 warn / 20 critical, function 50 lines, ` +
            `4 parameters) and are workspace-tunable — a number crossing a threshold is a ` +
            `judgement about the threshold as much as about the code.`,
        ].join('\n')
      : [
          '**Debt signals only — no scanner has run on these repositories.**',
          '',
          'Complexity, duplication, structural slop and logging hygiene are ABSENT from this ' +
            'report because nothing has measured them, not because they were measured and found ' +
            'clean. The rework and revert figures below come from ingested history alone and are ' +
            'available for every repository.',
        ].join('\n'),
  });

  // 2. Debt signals — always available, because they need only history.
  sections.push(
    debt.size > 0
      ? {
          kind: 'table',
          id: 'debt_signals',
          columns: ['Signal', 'Value', 'Basis'],
          rows: [
            [
              'Rework (14 day)',
              debt.get('M13') ?? null,
              'Share of changed lines touching a file changed again within 14 days. High is normal in a young feature and notable in a mature one.',
            ],
            [
              'Revert rate',
              debt.get('M14') ?? null,
              'HEURISTIC: reverts are detected from commit-message shape. A revert is often the correct response to a bad deploy — this counts how often the team had to undo, not how careless it is.',
            ],
          ],
        }
      : {
          kind: 'no_data',
          id: 'debt_signals',
          reason:
            'No rework or revert snapshots in scope. These need only ingested commit history, so an empty result here means ingestion has not run rather than that no work was redone.',
        },
  );

  // 3. Posture — the enriched half.
  sections.push(
    posture.size > 0
      ? {
          kind: 'table',
          id: 'code_health_posture',
          columns: ['Measure', 'Value', 'Threshold'],
          rows: [
            ['Duplication %', posture.get('ch_duplication_pct') ?? null, 5],
            ['Complexity p90', posture.get('ch_complexity_p90') ?? null, 20],
            ['Functions past critical complexity', posture.get('ch_worst_fn_count') ?? null, 0],
          ],
        }
      : {
          kind: 'no_data',
          id: 'code_health_posture',
          reason:
            'No complexity or duplication measurements exist for these repositories at the report snapshot. The code-health scanner has not run — this is "not measured", not "measured and clean".',
        },
  );

  // 4. Per-scanner coverage, so the absence of findings has a cause attached.
  sections.push(
    runs.length > 0
      ? {
          kind: 'table',
          id: 'code_health_coverage',
          columns: ['Repository', 'Scanner', 'Last run', 'Status'],
          rows: runs
            .slice(0, 20)
            .map((run) => [
              repoName.get(run.repoId) ?? String(run.repoId),
              run.scannerKey,
              (run.finishedAt ?? run.startedAt).toISOString(),
              run.status,
            ]),
        }
      : {
          kind: 'no_data',
          id: 'code_health_coverage',
          reason:
            'No code-health scanner run is recorded at or before this snapshot. Every empty section above follows from this one.',
        },
  );

  const findingScope =
    params.repoIds.length > 0
      ? and(
          eq(read.findings.workspaceId, params.workspaceId),
          inArray(read.findings.repoId, params.repoIds),
        )
      : eq(read.findings.workspaceId, params.workspaceId);

  const findings = await db
    .select({
      ruleId: read.findings.ruleId,
      severity: read.findings.severity,
      file: read.findings.file,
      title: read.findings.title,
      dimension: read.findings.dimension,
    })
    .from(read.findings)
    .where(
      and(
        findingScope,
        inArray(read.findings.dimension, ['code_health', 'logging']),
        inArray(read.findings.status, ['open', 'confirmed']),
        lte(read.findings.firstSeenAt, params.snapshotAt),
      ),
    );

  const byRule = new Map<string, number>();
  for (const finding of findings) {
    const key = finding.ruleId ?? 'unattributed';
    byRule.set(key, (byRule.get(key) ?? 0) + 1);
  }

  sections.push(
    byRule.size > 0
      ? {
          kind: 'table',
          id: 'code_health_by_rule',
          columns: ['Rule', 'Open findings'],
          // Sorted by count then rule id: a tie broken by insertion order
          // would reorder between two runs over identical data (W8-11).
          rows: [...byRule.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([rule, count]) => [rule, count]),
        }
      : {
          kind: 'no_data',
          id: 'code_health_by_rule',
          reason:
            'No open code-health or logging findings. Read this together with the coverage section: with no scanner run, it means nothing has looked.',
        },
  );

  sections.push({
    kind: 'summary',
    id: 'code_health_footnotes',
    markdown: [
      '**How to read this report.**',
      '',
      '- Thresholds are defaults, not laws. Duplication 5%, cyclomatic 10 warn / 20 critical, function 50 lines, 4 parameters — each is workspace-tunable, and a finding states the measured number beside the threshold it crossed.',
      '- Cognitive complexity and nesting depth are NOT measured: the tool reports cyclomatic complexity, and deriving a "cognitive" number from it would be the same number with a different name.',
      '- Structural-slop judgements come from a model and are shown only after an independent verifier failed to refute them. Rule-based findings are deterministic.',
      '- Rework and revert rates are debt SIGNALS. Neither is a verdict, and both have caveats recorded in the metric catalog.',
      '- An empty section says which fact it is: "not measured" and "measured and clean" are never rendered the same way.',
    ].join('\n'),
  });

  return sections;
}
