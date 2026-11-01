import { and, eq, gte, inArray, notInArray } from 'drizzle-orm';
import { facts, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { scanOneTarget, scannerEnabled, type StreamScanTarget } from './stream.js';
import type { SecretsVerificationConfig } from './verify.js';

// History mode (W8-05, SECURITY_SUITE.md 3.1 / 4, FR-SEC-4).
//
// Stream mode only ever sees the diffs arriving now, so it cannot see a
// credential that was committed last March and deleted in April — which is the
// leak that matters most, because deleting a secret from the working tree
// changes nothing about the secret. This sweeps the 12-month window instead.
//
// WHERE THE DESIGN AND THE WAREHOUSE DISAGREE, AND WHAT THIS DOES ABOUT IT.
// SECURITY_SUITE.md 3.1 says history mode needs no forge calls because "patches
// are already warehoused". They are not: commit_files and pr_files carry per-
// file churn COUNTS and say so in their own headers ("No patch text"), because
// DATABASE.md never made room for diff bodies and C1 keeps whole-repo source off
// this machine. So history mode re-fetches patches per commit through the
// budgeted client on the `scan` lane, which costs one core point per commit and
// is why it is capped, monthly, and reports what it deferred.
//
// The alternative — warehousing every patch body — is a storage and secret-
// exposure decision (a patch body containing a live key would then be a row in
// our database), not something to slip into a 2-point ticket.

export interface HistoryScanDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  /** Design 3.1: 12 months. */
  windowMonths?: number;
  /** Commits per sweep. The forge budget is the real limit (Law 7). */
  maxCommits?: number;
  trigger?: 'schedule' | 'manual';
  verification?: SecretsVerificationConfig;
  /**
   * W23-09 ("Full rescan"). Ignore which commits an earlier run covered and
   * sweep the window again, oldest first, up to the cap. Needed because the
   * `covered` filter below also counts a run still marked `running`, so a
   * commit whose worker died mid-scan was excluded from every later sweep with
   * no way back.
   */
  force?: boolean;
}

export interface HistoryScanResult {
  scanned: number;
  findingsCreated: number;
  /** Commits left for the next sweep — never silent (SECURITY_SUITE 1.2). */
  deferred: number;
  skipped?: 'disabled' | 'no_targets';
}

export function windowStart(windowMonths: number, now: Date): Date {
  const start = new Date(now);
  start.setMonth(start.getMonth() - windowMonths);
  return start;
}

/**
 * Commits inside the window that no secrets run has covered, oldest first.
 *
 * OLDEST FIRST, unlike stream mode: history exists to reach the far end of the
 * window, and newest-first would spend every capped sweep re-walking the recent
 * commits stream mode has already seen.
 */
export async function historyTargets(
  db: Database,
  workspaceId: number,
  repoId: number,
  opts: { windowMonths?: number; limit: number; now?: Date; force?: boolean },
): Promise<StreamScanTarget[]> {
  const since = windowStart(opts.windowMonths ?? 12, opts.now ?? new Date());

  const covered = db
    .select({ sha: security.scanRuns.commitSha })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.scannerKey, 'secrets'),
        // 'failed' is deliberately absent: a commit whose scan failed is
        // uncovered, and the next sweep should try it again.
        inArray(security.scanRuns.status, ['succeeded', 'running']),
      ),
    );

  const rows = await db
    .select({ sha: facts.commits.sha })
    .from(facts.commits)
    .where(
      and(
        eq(facts.commits.workspaceId, workspaceId),
        eq(facts.commits.repoId, repoId),
        gte(facts.commits.committedAt, since),
        // `force` bypasses the covered filter (W23-09); the window and the cap
        // still bound the sweep.
        ...(opts.force ? [] : [notInArray(facts.commits.sha, covered)]),
      ),
    )
    .orderBy(facts.commits.committedAt)
    .limit(opts.limit + 1);

  return rows.map((r) => ({ commitSha: r.sha }));
}

/**
 * Sweeps warehoused history for credentials nobody scanned at the time.
 *
 * Dedup comes free from the findings store: a secret still present in the
 * current tree was already reported by stream mode under the same dedup key,
 * so history re-reporting it bumps a sighting instead of creating a row. That
 * is the whole reason both modes go through persistFindings rather than
 * inserting their own findings.
 */
export async function runSecretsHistoryScan(deps: HistoryScanDeps): Promise<HistoryScanResult> {
  if (!(await scannerEnabled(deps.db, deps.workspaceId, deps.repoId))) {
    return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'disabled' };
  }

  const cap = deps.maxCommits ?? 200;
  const found = await historyTargets(deps.db, deps.workspaceId, deps.repoId, {
    limit: cap,
    ...(deps.force ? { force: true } : {}),
    ...(deps.windowMonths !== undefined ? { windowMonths: deps.windowMonths } : {}),
  });
  const targets = found.slice(0, cap);
  const deferred = Math.max(0, found.length - targets.length);

  if (targets.length === 0) {
    return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_targets' };
  }

  let findingsCreated = 0;
  let scanned = 0;
  for (const target of targets) {
    const created = await scanOneTarget(deps, target, deps.trigger ?? 'schedule');
    if (created === null) continue; // failure is on the scan_run row, not here
    findingsCreated += created;
    scanned += 1;
  }

  return { scanned, findingsCreated, deferred };
}
