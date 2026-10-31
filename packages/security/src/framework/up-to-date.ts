import { and, desc, eq, ne } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';

// "Is this scan already answered?" (W23-01, INCREMENTAL_SCAN_PLAN WP-R1/R2).
//
// Generalises the PR path's `headAlreadyScanned` (scanners/pr/run.ts), which
// asks only "was this head seen?". The weekly and manual runners had no such
// question at all: pressing Run scans now twice, or the weekly cron over a repo
// nobody pushed to, re-fetched a tarball and re-ran every tool for the same
// answer.
//
// WHAT COUNTS AS THE SAME QUESTION. Same workspace, repo, scanner and commit,
// AND the same tool versions, AND the same data version. Commit alone is not
// enough: a new rulepack or a refreshed advisory database changes what the
// same tree reports, and skipping then would be the old answer presented as the
// current one — the failure this product's copy exists to prevent.
//
// WHAT DOES NOT COUNT AS A BASELINE:
//   - anything but a SUCCEEDED run, or a PARTIAL one (its finding SET is not
//     the answer);
//   - a `skipped` row (it stands on a real run; chaining skips would let an
//     answer outlive the evidence for it);
//   - a `pr_synced` row: the PR semgrep path scans only the PR's changed
//     files, which is not the whole-tree answer a weekly/manual run owes.
//
// The framework never branches on a scanner key: the caller passes the key as
// data, and any scanner-specific knowledge (how to know the head, the tool
// versions, the data stamp) arrives through injected probes and registry
// metadata.

/** What a caller resolves, per scanner, about the run it is about to make. */
export interface ScanProbeResult {
  /** The commit the runner would pin to. */
  commitSha: string;
  /**
   * The tool + rulepack versions the runner would stamp. Omit/null ONLY when
   * the runner stamps none; a scanner whose versions are known only after it
   * runs must not provide a probe at all (it then always runs).
   */
  toolVersions?: Record<string, string> | null;
  /** Overrides the registry's `dataVersion()` when the probe knows better. */
  dataVersion?: string | null;
}

/**
 * Resolves what the runner for one scanner would pin to and stamp, WITHOUT
 * doing the work. Injected by key (like historyRunners/weeklyRunners).
 * Returns null when it cannot say — the caller then runs the scan.
 */
export type ScanProbe = (args: {
  workspaceId: number;
  repoId: number;
}) => Promise<ScanProbeResult | null>;

export interface UpToDateQuery {
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  commitSha: string;
  toolVersions?: Record<string, string> | null | undefined;
  dataVersion?: string | null | undefined;
}

/** The earlier run an up-to-date answer stands on. */
export interface UpToDateMatch {
  id: number;
  findingCount: number;
  toolVersions: Record<string, string> | null;
  dataVersion: string | null;
  scannerVersion: string;
  finishedAt: Date | null;
}

/** How many recent candidates to compare in memory; versions are compared as JSON. */
const CANDIDATE_LIMIT = 25;

function isEmptyVersions(v: Record<string, string> | null | undefined): boolean {
  return v === null || v === undefined;
}

/** Deep-equal on string maps, key order irrelevant; null/undefined on both sides is equal. */
export function toolVersionsEqual(
  a: Record<string, string> | null | undefined,
  b: Record<string, string> | null | undefined,
): boolean {
  if (isEmptyVersions(a) || isEmptyVersions(b)) return isEmptyVersions(a) && isEmptyVersions(b);
  const ka = Object.keys(a!).sort();
  const kb = Object.keys(b!).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a![k] === b![k]);
}

/**
 * The matching earlier run, or null. Newest first, so the baseline a skipped
 * row points at is the most recent run that answered the question.
 *
 * The WHERE clause does the narrowing; the same predicates are re-applied in
 * memory so the tenancy and "same commit" guarantees do not rest on one layer
 * (and so a fake db in a unit test exercises them for real).
 */
export async function isUpToDate(db: Database, q: UpToDateQuery): Promise<UpToDateMatch | null> {
  if (q.commitSha === '') return null;

  const rows = await db
    .select({
      id: security.scanRuns.id,
      workspaceId: security.scanRuns.workspaceId,
      repoId: security.scanRuns.repoId,
      scannerKey: security.scanRuns.scannerKey,
      commitSha: security.scanRuns.commitSha,
      status: security.scanRuns.status,
      partial: security.scanRuns.partial,
      scope: security.scanRuns.scope,
      trigger: security.scanRuns.trigger,
      findingCount: security.scanRuns.findingCount,
      toolVersions: security.scanRuns.toolVersions,
      dataVersion: security.scanRuns.dataVersion,
      scannerVersion: security.scanRuns.scannerVersion,
      finishedAt: security.scanRuns.finishedAt,
    })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, q.workspaceId),
        eq(security.scanRuns.repoId, q.repoId),
        eq(security.scanRuns.scannerKey, q.scannerKey),
        eq(security.scanRuns.commitSha, q.commitSha),
        eq(security.scanRuns.status, 'succeeded'),
        eq(security.scanRuns.partial, false),
        ne(security.scanRuns.scope, 'skipped'),
        ne(security.scanRuns.trigger, 'pr_synced'),
      ),
    )
    .orderBy(desc(security.scanRuns.id))
    .limit(CANDIDATE_LIMIT);

  for (const row of rows) {
    if (row.workspaceId !== q.workspaceId) continue;
    if (row.repoId !== q.repoId) continue;
    if (row.scannerKey !== q.scannerKey) continue;
    if (row.commitSha !== q.commitSha) continue;
    if (row.status !== 'succeeded' || row.partial) continue;
    if (row.scope === 'skipped' || row.trigger === 'pr_synced') continue;
    if (!toolVersionsEqual(row.toolVersions, q.toolVersions)) continue;
    // null on the QUERY side ignores the comparison; a stamp the query carries
    // must match the one the run recorded (a run with no stamp cannot match).
    if (q.dataVersion !== null && q.dataVersion !== undefined && row.dataVersion !== q.dataVersion)
      continue;
    return {
      id: row.id,
      findingCount: row.findingCount,
      toolVersions: row.toolVersions,
      dataVersion: row.dataVersion,
      scannerVersion: row.scannerVersion,
      finishedAt: row.finishedAt,
    };
  }
  return null;
}
