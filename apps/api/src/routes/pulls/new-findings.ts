import { and, desc, eq, gte, inArray, isNull, lt, max, ne, or, sql, type SQL } from 'drizzle-orm';
import { facts, read, security, type Database } from '@repopulse/shared';
import { BUILTIN_SCANNERS, isEnabled } from '@repopulse/security';

// "What is new on this PR?" (W18-18) — the question a customer's CI asks.
//
// WHAT "NEW" MEANS, given how findings are stored. A finding is ONE row per
// (repo, dedup key): a later sighting bumps last_seen_at on the existing row
// rather than inserting another. So a row that was first created by a scan of
// this PR is, by construction, a finding RepoPulse had not seen anywhere in the
// repository before — including on the base branch. That first-sighting
// attribution is what "introduced by the PR" means here. Two ways a row carries
// it:
//
//   1. pull_request_id = this PR — the PR-aware scanners (anti-slop, logging,
//      perf, owasp, secrets stream, verify) stamp it on insert;
//   2. pull_request_id IS NULL and scan_run_id is a pr_synced run AT THIS PR'S
//      HEAD — the semgrep incremental pass does not stamp the PR, but its run
//      records the commit it scanned, and the head SHA belongs to this PR.
//
// WHAT "PRESENT ON THE HEAD" MEANS. Incremental PR runs never auto-resolve
// (they have seen a handful of files, not the repo), so a finding introduced on
// the PR's first push and fixed on its second is still `open`. Every sighting
// bumps last_seen_at, so when scanner S has a succeeded run at the head commit,
// a finding from S that was NOT bumped by that run is not on the head, and is
// left out. A finding from a scanner that has NOT run at the head yet is kept
// and reported with seen_at_head=false: leaving it out would let a CI that asks
// too early pass a PR on the strength of a scan that has not happened.
//
// KNOWN LIMIT, stated rather than hidden: "not on the base" is relative to what
// RepoPulse has scanned. A scanner that has never scanned the base branch
// cannot tell a pre-existing problem in a touched file from a new one; the
// response carries `head.scanners` so the caller can see what was measured.

/** Only these count as present: dismissed / resolved / wont_fix are decisions a person already made. */
const LIVE_STATUSES = ['open', 'confirmed'] as const;

export interface PrFindingsQuery {
  workspaceId: number;
  repoId: number;
  prNumber: number;
  /** true: introduced by the PR. false: also pre-existing findings on files the PR touches. */
  newOnly: boolean;
  includeExperimental: boolean;
  cursor: { severity: number; id: number } | null;
  limit: number;
}

export interface PrFindingItem {
  id: number;
  rule_id: string | null;
  scanner_key: string | null;
  dimension: string;
  severity: number;
  severity_label: SeverityLabel;
  confidence: number;
  title: string;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  evidence: string;
  suggested_fix: string;
  experimental: boolean;
  status: string;
  introduced_by_pr: boolean;
  seen_at_head: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PrFindingsResult {
  pull: { number: number; title: string; state: string; head_sha: string; base_ref: string };
  head: {
    sha: string;
    /**
     * True once EVERY scanner that runs on a PR push for this repository has
     * finished a run (succeeded or failed) at the head commit (W20-15, UX_TODO
     * X-13). It used to turn true when any one scanner had, so a CI that asked
     * while only the fastest had finished judged the PR on a partial scan.
     */
    scanned: boolean;
    scanners: { scanner_key: string; scanned_at: string }[];
    /** PR scanners enabled here with no finished run at the head yet. */
    pending: string[];
    /** PR scanners whose latest finished run at the head did not succeed. */
    failed: string[];
  };
  items: PrFindingItem[];
  next_cursor: string | null;
}

/** Run states that mean the scanner is done with a commit, whatever it found. */
const FINISHED_RUN_STATUSES = ['succeeded', 'failed', 'budget_exceeded'] as const;

/** The scanners that run when a PR is pushed (catalogue triggers). */
export const PR_SCANNER_KEYS: readonly string[] = BUILTIN_SCANNERS.filter((s) =>
  s.triggers.includes('pr_synced'),
).map((s) => s.key);

/**
 * Which PR scanners are still to finish at the head, and which failed there
 * (W20-15, UX_TODO X-13). Pure so the rule is unit-tested without a database.
 */
export function headScanState(
  expected: readonly string[],
  finished: ReadonlyMap<string, string>,
  succeeded: ReadonlySet<string>,
): { scanned: boolean; pending: string[]; failed: string[] } {
  const pending = expected.filter((k) => !finished.has(k)).sort();
  const failed = [...finished]
    .filter(([key, status]) => status !== 'succeeded' && expected.includes(key))
    .map(([key]) => key)
    .sort();
  // With no PR scanner enabled here, any finished run at the head is all the
  // evidence there will ever be, as before.
  const scanned =
    expected.length > 0 ? pending.length === 0 : succeeded.size > 0 || finished.size > 0;
  return { scanned, pending, failed };
}

/** The canonical 1-5 scale (ANALYSIS_TIERS.md §4), named the way the UI names it. */
export const SEVERITY_LABELS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SeverityLabel = (typeof SEVERITY_LABELS)[number];

export function severityLabel(severity: number): SeverityLabel {
  return SEVERITY_LABELS[Math.min(5, Math.max(1, severity)) - 1] ?? 'info';
}

export function encodePrCursor(row: { severity: number; id: number }): string {
  return Buffer.from(`${row.severity}:${row.id}`).toString('base64url');
}

export function decodePrCursor(cursor: string): { severity: number; id: number } | null {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (parts.length !== 2) return null;
  const severity = Number(parts[0]);
  const id = Number(parts[1]);
  if (!Number.isInteger(severity) || !Number.isInteger(id)) return null;
  return { severity, id };
}

/** Null when the PR is not in the warehouse (not synced yet, or not this workspace's). */
export async function prFindings(
  db: Database,
  q: PrFindingsQuery,
): Promise<PrFindingsResult | null> {
  const [pr] = await db
    .select({
      id: facts.pullRequests.id,
      number: facts.pullRequests.number,
      title: facts.pullRequests.title,
      state: facts.pullRequests.state,
      headSha: facts.pullRequests.headSha,
      baseRef: facts.pullRequests.baseRef,
    })
    .from(facts.pullRequests)
    .where(
      and(
        eq(facts.pullRequests.workspaceId, q.workspaceId),
        eq(facts.pullRequests.repoId, q.repoId),
        eq(facts.pullRequests.number, q.prNumber),
      ),
    )
    .limit(1);
  if (!pr) return null;

  const atHead = and(
    eq(security.scanRuns.workspaceId, q.workspaceId),
    eq(security.scanRuns.repoId, q.repoId),
    eq(security.scanRuns.commitSha, pr.headSha),
  );

  // Latest succeeded run per scanner at the head commit.
  const headRuns = await db
    .select({
      scannerKey: security.scanRuns.scannerKey,
      startedAt: max(security.scanRuns.startedAt),
    })
    .from(security.scanRuns)
    .where(and(atHead, eq(security.scanRuns.status, 'succeeded')))
    .groupBy(security.scanRuns.scannerKey);
  const scannedAt = new Map<string, Date>();
  for (const r of headRuns) if (r.startedAt) scannedAt.set(r.scannerKey, r.startedAt);

  // W20-15 (UX_TODO X-13): which PR scanners are enabled for this repository,
  // and which of them have FINISHED at the head (latest run per scanner).
  const configRows = await db
    .select({
      scannerKey: security.repoScannerConfig.scannerKey,
      enabled: security.repoScannerConfig.enabled,
    })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, q.workspaceId),
        eq(security.repoScannerConfig.repoId, q.repoId),
        inArray(security.repoScannerConfig.scannerKey, [...PR_SCANNER_KEYS]),
      ),
    );
  const config = new Map(configRows.map((r) => [r.scannerKey, { enabled: r.enabled }]));
  const expected = PR_SCANNER_KEYS.filter((k) => isEnabled(k, config.get(k)));
  const finishedRuns = await db
    .select({ scannerKey: security.scanRuns.scannerKey, status: security.scanRuns.status })
    .from(security.scanRuns)
    .where(and(atHead, inArray(security.scanRuns.status, [...FINISHED_RUN_STATUSES])))
    .orderBy(desc(security.scanRuns.startedAt), desc(security.scanRuns.id));
  const finished = new Map<string, string>();
  for (const r of finishedRuns)
    if (!finished.has(r.scannerKey)) finished.set(r.scannerKey, r.status);
  const headState = headScanState(expected, finished, new Set(scannedAt.keys()));

  // Every PR-triggered run at the head, any outcome: attribution rule 2 above.
  const prRunIds = (
    await db
      .select({ id: security.scanRuns.id })
      .from(security.scanRuns)
      .where(and(atHead, eq(security.scanRuns.trigger, 'pr_synced')))
  ).map((r) => r.id);

  const introduced: SQL =
    prRunIds.length === 0
      ? eq(read.findings.pullRequestId, pr.id)
      : (or(
          eq(read.findings.pullRequestId, pr.id),
          and(isNull(read.findings.pullRequestId), inArray(read.findings.scanRunId, prRunIds)),
        ) as SQL);

  const scope: SQL = q.newOnly
    ? introduced
    : (or(
        introduced,
        inArray(
          read.findings.file,
          db
            .select({ path: facts.prFiles.path })
            .from(facts.prFiles)
            .where(
              and(
                eq(facts.prFiles.workspaceId, q.workspaceId),
                eq(facts.prFiles.pullRequestId, pr.id),
              ),
            ),
        ),
      ) as SQL);

  const filters: SQL[] = [
    eq(read.findings.workspaceId, q.workspaceId),
    eq(read.findings.repoId, q.repoId),
    inArray(read.findings.status, [...LIVE_STATUSES]),
    scope,
  ];
  if (!q.includeExperimental) filters.push(eq(read.findings.experimental, false));
  // Not bumped by its scanner's head run ⇒ not on the head.
  for (const [scannerKey, startedAt] of scannedAt) {
    filters.push(
      or(
        isNull(read.findings.scannerKey),
        ne(read.findings.scannerKey, scannerKey),
        gte(read.findings.lastSeenAt, startedAt),
      ) as SQL,
    );
  }
  if (q.cursor) {
    filters.push(
      or(
        lt(read.findings.severity, q.cursor.severity),
        and(eq(read.findings.severity, q.cursor.severity), lt(read.findings.id, q.cursor.id)),
      ) as SQL,
    );
  }

  const rows = await db
    .select({
      id: read.findings.id,
      ruleId: read.findings.ruleId,
      scannerKey: read.findings.scannerKey,
      dimension: read.findings.dimension,
      severity: read.findings.severity,
      confidence: read.findings.confidence,
      title: read.findings.title,
      file: read.findings.file,
      lineStart: read.findings.lineStart,
      lineEnd: read.findings.lineEnd,
      evidence: read.findings.evidence,
      recommendation: read.findings.recommendation,
      experimental: read.findings.experimental,
      status: read.findings.status,
      firstSeenAt: read.findings.firstSeenAt,
      lastSeenAt: read.findings.lastSeenAt,
      introducedSql: sql<boolean>`${introduced}`,
    })
    .from(read.findings)
    .where(and(...filters))
    .orderBy(desc(read.findings.severity), desc(read.findings.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    pull: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head_sha: pr.headSha,
      base_ref: pr.baseRef,
    },
    head: {
      sha: pr.headSha,
      scanned: headState.scanned,
      scanners: [...scannedAt]
        .map(([scanner_key, at]) => ({ scanner_key, scanned_at: at.toISOString() }))
        .sort((a, b) => a.scanner_key.localeCompare(b.scanner_key)),
      pending: headState.pending,
      failed: headState.failed,
    },
    items: page.map((r) => {
      const headRun = r.scannerKey === null ? undefined : scannedAt.get(r.scannerKey);
      return {
        id: r.id,
        rule_id: r.ruleId,
        scanner_key: r.scannerKey,
        dimension: r.dimension,
        severity: r.severity,
        severity_label: severityLabel(r.severity),
        confidence: r.confidence,
        title: r.title,
        file: r.file,
        line_start: r.lineStart,
        line_end: r.lineEnd,
        evidence: r.evidence,
        suggested_fix: r.recommendation,
        experimental: r.experimental,
        status: r.status,
        introduced_by_pr: r.introducedSql === true,
        seen_at_head: headRun !== undefined && r.lastSeenAt >= headRun,
        first_seen_at: r.firstSeenAt.toISOString(),
        last_seen_at: r.lastSeenAt.toISOString(),
      };
    }),
    next_cursor: rows.length > q.limit && last ? encodePrCursor(last) : null,
  };
}
