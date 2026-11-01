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

// W23-04 stores the input hash inside `tool_versions` under these two keys
// (input-hash.ts INPUT_HASH_KEY / INPUT_PATHS_KEY — a test pins them equal). They
// describe what a run READ, not which tools produced it, so a comparison of tool
// versions must not see them: a baseline stamped with an input hash is still the
// same question as a probe that knows only the engines.
const INPUT_STAMP_KEYS: ReadonlySet<string> = new Set(['input_hash', 'input_paths']);

function withoutInputStamp(
  v: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined {
  if (v === null || v === undefined) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !INPUT_STAMP_KEYS.has(k)));
}

/**
 * Deep-equal on string maps, key order irrelevant; null/undefined on both sides
 * is equal. The W23-04 input stamp (`input_hash`, `input_paths`) is ignored.
 */
export function toolVersionsEqual(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined,
): boolean {
  const a = withoutInputStamp(left);
  const b = withoutInputStamp(right);
  if (isEmptyVersions(a) || isEmptyVersions(b)) return isEmptyVersions(a) && isEmptyVersions(b);
  const ka = Object.keys(a!).sort();
  const kb = Object.keys(b!).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a![k] === b![k]);
}

/**
 * The earlier SUCCEEDED, non-partial runs that could stand as a baseline for
 * this question, newest first — before any version comparison.
 *
 * The WHERE clause does the narrowing; the same predicates are re-applied in
 * memory so the tenancy and "same commit" guarantees do not rest on one layer
 * (and so a fake db in a unit test exercises them for real).
 */
async function baselineCandidates(
  db: Database,
  q: Pick<UpToDateQuery, 'workspaceId' | 'repoId' | 'scannerKey' | 'commitSha'>,
) {
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

  return rows.filter(
    (row) =>
      row.workspaceId === q.workspaceId &&
      row.repoId === q.repoId &&
      row.scannerKey === q.scannerKey &&
      row.commitSha === q.commitSha &&
      row.status === 'succeeded' &&
      !row.partial &&
      row.scope !== 'skipped' &&
      row.trigger !== 'pr_synced',
  );
}

function toMatch(row: Awaited<ReturnType<typeof baselineCandidates>>[number]): UpToDateMatch {
  return {
    id: row.id,
    findingCount: row.findingCount,
    toolVersions: row.toolVersions,
    dataVersion: row.dataVersion,
    scannerVersion: row.scannerVersion,
    finishedAt: row.finishedAt,
  };
}

/**
 * The newest run a probe may CACHE versions from (W23-09): same workspace, repo,
 * scanner and commit, succeeded and whole. Its `toolVersions` are what a re-run
 * of the same inputs would stamp, which is how a probe answers "which engine
 * version would this use" without starting the engine. Null when no run has
 * answered this commit, in which case there is nothing to skip to either.
 */
export async function latestBaseline(
  db: Database,
  q: Pick<UpToDateQuery, 'workspaceId' | 'repoId' | 'scannerKey' | 'commitSha'>,
): Promise<UpToDateMatch | null> {
  if (q.commitSha === '') return null;
  const [row] = await baselineCandidates(db, q);
  return row ? toMatch(row) : null;
}

/**
 * The matching earlier run, or null. Newest first, so the baseline a skipped
 * row points at is the most recent run that answered the question.
 */
export async function isUpToDate(db: Database, q: UpToDateQuery): Promise<UpToDateMatch | null> {
  if (q.commitSha === '') return null;

  for (const row of await baselineCandidates(db, q)) {
    if (!toolVersionsEqual(row.toolVersions, q.toolVersions)) continue;
    // null on the QUERY side ignores the comparison; a stamp the query carries
    // must match the one the run recorded (a run with no stamp cannot match).
    if (q.dataVersion !== null && q.dataVersion !== undefined && row.dataVersion !== q.dataVersion)
      continue;
    return toMatch(row);
  }
  return null;
}

// Re-exported here because the package barrel already exports this module; the
// stamp helpers are the other half of the same question ("what would this run
// stand on?") and every probe needs both.
export { dataStamp, ruleStateStamp, shortHash } from './data-stamp.js';
