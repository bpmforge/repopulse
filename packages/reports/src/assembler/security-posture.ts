import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { core, read, type Database } from '@repopulse/shared';
import type { ReportSection } from '../types/index.js';

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
  const findings = await db
    .select({
      repoId: read.findings.repoId,
      severity: read.findings.severity,
      status: read.findings.status,
      firstSeenAt: read.findings.firstSeenAt,
      verifyStatus: read.findings.verifyStatus,
    })
    .from(read.findings)
    .where(
      and(
        repoFilter,
        eq(read.findings.dimension, 'security'),
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
          columns: ['Repository', 'Severity', 'Age', 'Verification'],
          rows: findings
            .sort((a, b) => b.severity - a.severity)
            .map((f) => [
              repoName.get(f.repoId) ?? String(f.repoId),
              f.severity,
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

  // 3. Dependency and secret signals — heuristic, and labelled as such.
  sections.push({
    kind: 'no_data',
    id: 'dependency_secret_signals',
    reason:
      'Manifest-diff and secret-pattern signals are not computed in this version. They are HEURISTIC by design (v1.x, REPORTS.md §1) — a pattern match is not a confirmed leak — and this report will label them so when they land in W8 rather than presenting them beside scanner findings as equals.',
  });

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
