import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { core, read, security, type Database } from '@repopulse/shared';
import { SECURITY_DIMENSIONS } from '@repopulse/insights';
import type { ReportSection } from '../types/index.js';
import type { ChainAppendixEntry, ScannerPosture } from '../types/security-posture.js';

// Security Posture report (W7-03, REPORTS.md §1, FR-REPORTS-4).
//
// This is the report most likely to be read by someone who did not run it — an
// auditor, a customer's security team, a board pack. Two consequences shape
// every section below: nothing may look like a measurement when it is a
// heuristic, and an empty section must say WHY it is empty. "No findings" and
// "nothing has analysed this repository" are the same shape on a page and
// opposite facts in a meeting.

export interface SecurityPostureParams {
  workspaceId: number;
  repoIds: number[];
  snapshotAt: Date;
  windowStart: Date;
}

const AGE_BUCKETS = [
  { label: '0–7 days', maxDays: 7 },
  { label: '8–30 days', maxDays: 30 },
  { label: '31–90 days', maxDays: 90 },
  { label: 'over 90 days', maxDays: Number.POSITIVE_INFINITY },
] as const;

/** Severity in words (W20-15, UX_TODO X-23): a bare "4" means nothing to an auditor. */
export function severityWord(severity: number): string {
  return SEVERITY_WORDS[severity] ?? String(severity);
}
const SEVERITY_WORDS: Record<number, string> = {
  5: 'critical',
  4: 'high',
  3: 'medium',
  2: 'low',
  1: 'info',
};

function ageBucket(firstSeen: Date, asOf: Date): string {
  const days = (asOf.getTime() - firstSeen.getTime()) / 86_400_000;
  return (AGE_BUCKETS.find((b) => days <= b.maxDays) ?? AGE_BUCKETS[3]).label;
}

export async function securityPostureSections(
  db: Database,
  params: SecurityPostureParams,
): Promise<ReportSection[]> {
  const sections: ReportSection[] = [];
  const repoFilter =
    params.repoIds.length > 0
      ? and(
          eq(read.findings.workspaceId, params.workspaceId),
          inArray(read.findings.repoId, params.repoIds),
        )
      : eq(read.findings.workspaceId, params.workspaceId);

  const repos = await db
    .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
    .from(core.repos)
    .where(eq(core.repos.workspaceId, params.workspaceId));
  const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

  // 1. Open security findings by severity × repo × age.
  //
  // W20-15 (UX_TODO X-21): every SECURITY dimension, the same set the Security
  // tab and the Security sub-score use. Filtering on the literal 'security'
  // left out leaked secrets, dependency CVEs, SAST, IaC and attack chains, so
  // a repository with a live leaked token could read "No open security
  // findings". Shadow-rule findings stay out, as in the risk report.
  const findings = await db
    .select({
      id: read.findings.id,
      repoId: read.findings.repoId,
      severity: read.findings.severity,
      dimension: read.findings.dimension,
      title: read.findings.title,
      file: read.findings.file,
      lineStart: read.findings.lineStart,
      ruleId: read.findings.ruleId,
      status: read.findings.status,
      firstSeenAt: read.findings.firstSeenAt,
      verifyStatus: read.findings.verifyStatus,
    })
    .from(read.findings)
    .where(
      and(
        repoFilter,
        inArray(read.findings.dimension, SECURITY_DIMENSIONS),
        eq(read.findings.experimental, false),
        inArray(read.findings.status, ['open', 'confirmed']),
        // Only findings that existed when the report was pinned — a finding
        // raised after the snapshot did not inform this report.
        lte(read.findings.firstSeenAt, params.snapshotAt),
      ),
    );

  sections.push(
    findings.length > 0
      ? {
          kind: 'table',
          id: 'open_security_findings',
          // W20-15 (UX_TODO X-23): which finding each row is. Four columns
          // (repository, a bare severity number, age, verification) did not
          // let a reader tell rows apart or find one in RepoPulse.
          columns: [
            'Finding #',
            'Repository',
            'Severity',
            'Dimension',
            'Finding',
            'Location',
            'Rule',
            'Age',
            'Verification',
          ],
          findingIdColumn: 0,
          rows: findings
            // Severity, then id: a tie broken by insertion order would reorder
            // between two runs over identical data (FR-REPORTS-6).
            .sort((a, b) => b.severity - a.severity || a.id - b.id)
            .map((f) => [
              f.id,
              repoName.get(f.repoId) ?? String(f.repoId),
              severityWord(f.severity),
              f.dimension,
              f.title,
              f.file === null
                ? 'whole repository'
                : f.lineStart === null
                  ? f.file
                  : `${f.file}:${f.lineStart}`,
              f.ruleId,
              ageBucket(f.firstSeenAt, params.snapshotAt),
              // Carried into the report because an UNVERIFIED critical finding
              // and one a second model confirmed are different claims, and a
              // security document that flattens them overstates its case.
              f.verifyStatus,
            ]),
        }
      : {
          kind: 'no_data',
          id: 'open_security_findings',
          reason:
            'No open security findings. Note this means none were RAISED — if no analysis run has covered these repositories, the correct reading is "not yet examined" rather than "clean". The egress and lifecycle sections below show whether analysis has run.',
        },
  );

  // 2. Review-bypass exposure (M6). Tier-1 — always available.
  const m6 = await db
    .select({
      repoId: read.metricSnapshots.repoId,
      value: read.metricSnapshots.value,
      computedAt: read.metricSnapshots.computedAt,
    })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, params.workspaceId),
        eq(read.metricSnapshots.metricKey, 'M6'),
        lte(read.metricSnapshots.computedAt, params.snapshotAt),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt))
    .limit(50);

  const latestByRepo = new Map<number | null, { value: string | null }>();
  for (const row of m6) if (!latestByRepo.has(row.repoId)) latestByRepo.set(row.repoId, row);

  sections.push(
    latestByRepo.size > 0
      ? {
          kind: 'table',
          id: 'review_bypass',
          columns: ['Repository', 'Unreviewed merge rate'],
          rows: [...latestByRepo.entries()].map(([repoId, row]) => [
            repoId === null ? 'organisation' : (repoName.get(repoId) ?? String(repoId)),
            row.value === null ? null : Math.round(Number(row.value) * 1000) / 1000,
          ]),
        }
      : {
          kind: 'no_data',
          id: 'review_bypass',
          reason:
            'No review-coverage snapshots in scope. This section is Tier-1 — it needs only ingested pull requests, so an empty result here means ingestion has not run rather than that no merges bypassed review.',
        },
  );

  // 3. One section per scanner the warehouse knows about (W8-11).
  sections.push(...(await scannerSections(db, params)));

  // 4. Egress audit summary (NFR-9).
  const [egress] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${read.egressAudit.bytesSent}), 0)::int`,
      repos: sql<number>`count(distinct ${read.egressAudit.repoId})::int`,
      initiators: sql<number>`count(distinct ${read.egressAudit.initiatorUserId})::int`,
    })
    .from(read.egressAudit)
    .where(
      and(
        eq(read.egressAudit.workspaceId, params.workspaceId),
        gte(read.egressAudit.sentAt, params.windowStart),
        lte(read.egressAudit.sentAt, params.snapshotAt),
      ),
    );

  sections.push(
    (egress?.calls ?? 0) > 0
      ? {
          kind: 'table',
          id: 'egress_audit',
          columns: ['Measure', 'Value'],
          rows: [
            ['Tier-3 calls', egress!.calls],
            ['Bytes sent off-network', egress!.bytes],
            ['Repositories involved', egress!.repos],
            ['Distinct initiators', egress!.initiators],
          ],
        }
      : {
          kind: 'no_data',
          id: 'egress_audit',
          // The most reassuring empty section in the product, and it must not
          // be confusable with "we did not record it".
          reason:
            'No code left this network in the reporting window: zero Tier-3 calls were made. This is measured from the egress audit log, which is written before each call rather than after it.',
        },
  );

  // 5. Finding lifecycle stats.
  const [lifecycle] = await db
    .select({
      total: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${read.findings.status} = 'resolved')::int`,
      dismissedFp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
      meanOpenDays: sql<
        number | null
      >`avg(extract(epoch from (coalesce(${read.findings.statusChangedAt}, now()) - ${read.findings.firstSeenAt})) / 86400)`,
    })
    .from(read.findings)
    .where(repoFilter);

  sections.push(
    (lifecycle?.total ?? 0) > 0
      ? {
          kind: 'table',
          id: 'finding_lifecycle',
          columns: ['Measure', 'Value'],
          rows: [
            ['Findings recorded', lifecycle!.total],
            ['Resolved', lifecycle!.resolved],
            ['Dismissed as false positive', lifecycle!.dismissedFp],
            [
              'Mean days open',
              lifecycle!.meanOpenDays === null
                ? null
                : Math.round(Number(lifecycle!.meanOpenDays) * 10) / 10,
            ],
            [
              'False-positive rate',
              // null over an empty set, never 0: a 0% false-positive rate
              // across zero findings reads as a flawless model.
              lifecycle!.total === 0
                ? null
                : Math.round((lifecycle!.dismissedFp / lifecycle!.total) * 1000) / 1000,
            ],
          ],
        }
      : {
          kind: 'no_data',
          id: 'finding_lifecycle',
          reason:
            'No findings have been recorded for these repositories, so there is no lifecycle to report. This is the same fact as the empty findings section above, stated where a reader looking for triage discipline would look for it.',
        },
  );

  // Appendix B (REPORTS.md §5.5): what the reader needs to interpret the above.
  sections.push({
    kind: 'summary',
    id: 'appendix_b',
    markdown: [
      '**Appendix B — how to read this report.**',
      '',
      '- Severity is 1–5, 5 = critical. Confidence is the analysing model’s own, not a measured probability.',
      '- `unverified` means no second model re-judged the finding. It is not a weaker finding; it is an unchecked one.',
      '- The egress audit records every Tier-3 call **before** it is made, so a crashed call still appears. Byte counts are of the prompt sent, and content is stored as a sha256 digest rather than a copy.',
      '- Dependency and secret signals are heuristic and are marked as such wherever they appear.',
      '- An empty section states why it is empty. "No findings" and "not yet analysed" are different facts and are never rendered the same way.',
    ].join('\n'),
  });

  return sections;
}

/**
 * Scanner posture, read entirely from the warehouse (W8-11, FR-SEC-10).
 *
 * WHY THIS DOES NOT IMPORT THE SCANNER REGISTRY. The registry is code, and code
 * changes: a report regenerated in six months would gain sections for scanners
 * that did not exist when it was first produced, and lose them for scanners
 * that were removed — which breaks the byte-identical guarantee (FR-REPORTS-6)
 * in a way nobody would notice until an auditor compared two copies. So the
 * catalogue here is what the DATA says: every scanner with a config row or a
 * run at or before snapshotAt. A scanner nobody has ever configured or run is
 * absent from the report and present on the Security tab, which is the screen
 * that legitimately reflects the live registry.
 */
export async function scannerPostures(
  db: Database,
  params: SecurityPostureParams,
): Promise<ScannerPosture[]> {
  const repoScope =
    params.repoIds.length > 0
      ? and(
          eq(security.scanRuns.workspaceId, params.workspaceId),
          inArray(security.scanRuns.repoId, params.repoIds),
        )
      : eq(security.scanRuns.workspaceId, params.workspaceId);

  const runs = await db
    .select()
    .from(security.scanRuns)
    .where(and(repoScope, lte(security.scanRuns.startedAt, params.snapshotAt)))
    .orderBy(desc(security.scanRuns.startedAt))
    .limit(2000);

  const configScope =
    params.repoIds.length > 0
      ? and(
          eq(security.repoScannerConfig.workspaceId, params.workspaceId),
          inArray(security.repoScannerConfig.repoId, params.repoIds),
        )
      : eq(security.repoScannerConfig.workspaceId, params.workspaceId);
  const configs = await db.select().from(security.repoScannerConfig).where(configScope);

  const findingScope =
    params.repoIds.length > 0
      ? and(
          eq(read.findings.workspaceId, params.workspaceId),
          inArray(read.findings.repoId, params.repoIds),
        )
      : eq(read.findings.workspaceId, params.workspaceId);

  const findings = await db
    .select({
      id: read.findings.id,
      scannerKey: read.findings.scannerKey,
      severity: read.findings.severity,
      title: read.findings.title,
      file: read.findings.file,
      ruleId: read.findings.ruleId,
      firstSeenAt: read.findings.firstSeenAt,
    })
    .from(read.findings)
    .where(
      and(
        findingScope,
        isNotNull(read.findings.scannerKey),
        inArray(read.findings.status, ['open', 'confirmed']),
        lte(read.findings.firstSeenAt, params.snapshotAt),
      ),
    );

  const keys = [
    ...new Set([
      ...runs.map((r) => r.scannerKey),
      ...configs.map((c) => c.scannerKey),
      ...findings.map((f) => f.scannerKey as string),
    ]),
  ].sort();

  return keys.map((key) => {
    const keyRuns = runs.filter((r) => r.scannerKey === key);
    const last = keyRuns[0];
    // The run BEFORE the latest one, which is what "since the previous run"
    // means. Absent on a scanner's first run — reported as null, not 0: "no
    // previous run to compare against" is not "nothing changed".
    const previous = keyRuns.find((r) => r.finishedAt && last && r.id !== last.id);

    // A scanner is disabled only if a row SAYS so. Absent config is null, not
    // false: an unconfigured scanner is running on the workspace default, and
    // printing "not enabled" for it would be a claim the warehouse cannot make.
    const configRows = configs.filter((c) => c.scannerKey === key);
    const enabled = configRows.length === 0 ? null : configRows.every((c) => c.enabled);

    const mine = findings.filter((f) => f.scannerKey === key);
    const bySeverity: Record<number, number> = {};
    for (const f of mine) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

    const cutoff = previous?.finishedAt ?? null;
    return {
      scannerKey: key,
      enabled,
      lastRunAt: last?.finishedAt ?? last?.startedAt ?? null,
      lastRunStatus: last?.status ?? null,
      scannerVersion: last?.scannerVersion ?? null,
      bySeverity,
      openTotal: mine.length,
      newSincePreviousRun:
        cutoff === null ? null : mine.filter((f) => f.firstSeenAt > cutoff).length,
      topFindings: mine
        // Severity first, then title: a tie broken by insertion order would
        // reorder between two runs over identical data and break the
        // byte-identical guarantee.
        .sort((a, b) => b.severity - a.severity || a.title.localeCompare(b.title) || a.id - b.id)
        .slice(0, 5)
        .map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          file: f.file,
          ruleId: f.ruleId,
        })),
    };
  });
}

/** Open chains, worst step first (SECURITY_SUITE §5 appendix). */
export async function chainAppendix(
  db: Database,
  params: SecurityPostureParams,
): Promise<ChainAppendixEntry[]> {
  const scope =
    params.repoIds.length > 0
      ? and(
          eq(read.findings.workspaceId, params.workspaceId),
          inArray(read.findings.repoId, params.repoIds),
        )
      : eq(read.findings.workspaceId, params.workspaceId);

  const rows = await db
    .select({
      chainId: read.findings.chainId,
      id: read.findings.id,
      title: read.findings.title,
      severity: read.findings.severity,
    })
    .from(read.findings)
    .where(
      and(
        scope,
        isNotNull(read.findings.chainId),
        inArray(read.findings.status, ['open', 'confirmed']),
        lte(read.findings.firstSeenAt, params.snapshotAt),
      ),
    )
    .orderBy(read.findings.id);

  const chains = new Map<string, ChainAppendixEntry>();
  for (const row of rows) {
    const chainId = row.chainId as string;
    const entry = chains.get(chainId) ?? { chainId, severity: 0, steps: [] };
    entry.steps.push({ findingId: row.id, title: row.title, severity: row.severity });
    // Worst step, never an average: an average lets one critical link hide
    // behind three trivial ones.
    entry.severity = Math.max(entry.severity, row.severity);
    chains.set(chainId, entry);
  }
  return [...chains.values()].sort(
    (a, b) => b.severity - a.severity || a.chainId.localeCompare(b.chainId),
  );
}

/** Per-scanner sections plus the chains appendix. */
export async function scannerSections(
  db: Database,
  params: SecurityPostureParams,
): Promise<ReportSection[]> {
  const postures = await scannerPostures(db, params);
  const sections: ReportSection[] = [];

  if (postures.length === 0) {
    // The degraded rendering (W7-03 Tier-1 only). Says which fact it is: no
    // scanner has been configured or run, which is not "the scanners found
    // nothing".
    sections.push({
      kind: 'no_data',
      id: 'scanner_posture',
      reason:
        'No scanner has been configured or has run for these repositories at or before the report snapshot, so this report carries no scanner sections. This is "not yet scanned", not "scanned and clean" — the Tier-1 sections above stand on ingested data alone and are unaffected.',
    });
    return sections;
  }

  for (const posture of postures) {
    const id = `scanner_${posture.scannerKey}`;
    if (posture.enabled === false) {
      sections.push({
        kind: 'no_data',
        id,
        reason: `The ${posture.scannerKey} scanner is switched off for these repositories, so nothing has looked. Any count of zero elsewhere in this report excludes what this scanner would have found.`,
      });
      continue;
    }
    if (posture.lastRunAt === null) {
      sections.push({
        kind: 'no_data',
        id,
        reason: `The ${posture.scannerKey} scanner is enabled but has not run at or before this snapshot. No findings from it are included, and that absence is not evidence of their absence in the code.`,
      });
      continue;
    }

    sections.push({
      kind: 'table',
      id,
      columns: ['Measure', 'Value'],
      rows: [
        ['Scanner', posture.scannerKey],
        ['Version', posture.scannerVersion],
        ['Last run', posture.lastRunAt.toISOString()],
        ['Last run status', posture.lastRunStatus],
        ['Open findings', posture.openTotal],
        ['Critical (5)', posture.bySeverity[5] ?? 0],
        ['High (4)', posture.bySeverity[4] ?? 0],
        // null, not 0, on a first run: "no previous run to compare against" is
        // a different fact from "nothing changed", and a 0 here would report a
        // brand-new scanner as having found nothing new.
        ['New since previous run', posture.newSincePreviousRun],
      ],
    });

    if (posture.topFindings.length > 0) {
      sections.push({
        kind: 'table',
        id: `${id}_top`,
        columns: ['Severity', 'Finding', 'Location', 'Rule', 'Finding #'],
        findingIdColumn: 4,
        rows: posture.topFindings.map((f) => [
          f.severity,
          f.title,
          // A repo-level finding genuinely has no location; an empty string
          // would render as a blank cell that looks like missing data.
          f.file ?? 'repository-level',
          f.ruleId,
          f.id,
        ]),
      });
    }
  }

  const chains = await chainAppendix(db, params);
  sections.push(
    chains.length > 0
      ? {
          kind: 'table',
          id: 'chains_appendix',
          columns: ['Chain', 'Severity', 'Steps'],
          rows: chains.map((chain) => [
            chain.chainId,
            chain.severity,
            chain.steps.map((s) => s.title).join(' → '),
          ]),
        }
      : {
          kind: 'no_data',
          id: 'chains_appendix',
          reason:
            "No attack chains are recorded for these repositories. Chain analysis correlates one finding's yields with another's preconditions; until it has run, the correct reading is that no chains have been LOOKED for, not that none exist.",
        },
  );

  return sections;
}
