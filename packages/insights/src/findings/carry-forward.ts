import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { autoResolveOutdated, type FindingStatus } from './lifecycle.js';

// Carry-forward merge for incremental scans (W23-03, INCREMENTAL_SCAN_PLAN §1
// "Merge", claim C12: incremental WORK, whole-tree RESULT).
//
// An incremental run scanned only the files that changed. Its answer for every
// OTHER file is the base run's answer, so this does the three things a full run
// would have done to those findings without reading the files:
//
//   unchanged file   the base run's findings are RE-SIGHTED on the new run: same
//                    rows (same dedup keys, so no duplicate and no new id), with
//                    last_seen and the sighting pointer moved to the new run.
//   deleted file     the findings are CLOSED, as a full sweep closes a finding
//                    on a file that is no longer in the tree.
//   changed file     NOT touched here. The new scan reports what is still wrong
//                    and `persistFindings` (reviewedFiles = the changed set, and
//                    NO tree list) dedups, re-sights and closes within exactly
//                    that file set.
//
// Findings are matched on `last_seen_scan_run_id = baseRunId`: "what the base run
// saw". A finding the base run did not see (closed since, or left alone by an
// earlier incremental) is not resurrected by being carried.
//
// Workspace and repo are in every WHERE and re-checked in memory, so a wrong id
// from a caller cannot reach another tenant's rows (Law 5).

export interface CarryForwardParams {
  db: Database;
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  baseRunId: number;
  newRunId: number;
  /** Files NOT in the delta: the base run's findings on them are re-sighted. */
  unchangedPaths: readonly string[];
  /** Files the delta deleted (or renamed away): findings on them are closed. */
  deletedPaths: readonly string[];
}

export interface CarryForwardResult {
  /** Rows re-sighted on the new run. */
  resighted: number;
  /** Rows closed because their file is gone. */
  closed: number;
}

const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Distinct files the findings last seen by `runId` sit on. The caller subtracts
 * the scanned and deleted files to get `unchangedPaths`: an incremental run has
 * no tree listing, so "every file the base run had findings on" is the only
 * universe of unchanged files there is.
 */
export async function filesSeenByRun(
  db: Database,
  q: { workspaceId: number; repoId: number; scannerKey: string; runId: number },
): Promise<string[]> {
  const rows = await db
    .select({
      file: read.findings.file,
      workspaceId: read.findings.workspaceId,
      repoId: read.findings.repoId,
      scannerKey: read.findings.scannerKey,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, q.workspaceId),
        eq(read.findings.repoId, q.repoId),
        eq(read.findings.scannerKey, q.scannerKey),
        eq(read.findings.lastSeenScanRunId, q.runId),
      ),
    );
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.workspaceId === q.workspaceId &&
            r.repoId === q.repoId &&
            r.scannerKey === q.scannerKey &&
            r.file !== null,
        )
        .map((r) => r.file as string),
    ),
  ];
}

export async function carryForward(p: CarryForwardParams): Promise<CarryForwardResult> {
  const now = new Date();
  const unchanged = new Set(p.unchangedPaths);
  const deleted = [...new Set(p.deletedPaths)].filter((f) => !unchanged.has(f));
  const result: CarryForwardResult = { resighted: 0, closed: 0 };

  // ---- re-sight what the base run saw on files nobody touched ---------------
  const seen = await p.db
    .select({
      id: read.findings.id,
      file: read.findings.file,
      workspaceId: read.findings.workspaceId,
      repoId: read.findings.repoId,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, p.workspaceId),
        eq(read.findings.repoId, p.repoId),
        eq(read.findings.scannerKey, p.scannerKey),
        eq(read.findings.lastSeenScanRunId, p.baseRunId),
      ),
    );
  const resightIds = seen
    .filter((r) => r.workspaceId === p.workspaceId && r.repoId === p.repoId)
    // A repo-level finding (no file) is not in any delta: the base run's word stands.
    .filter((r) => r.file === null || unchanged.has(r.file))
    .map((r) => r.id);
  for (const ids of chunks(resightIds)) {
    await p.db
      .update(read.findings)
      .set({
        lastSeenAt: now,
        lastSeenScanRunId: p.newRunId,
        // occurrence_count counts RUNS that saw a finding, as persistFindings does.
        occurrenceCount: sql`${read.findings.occurrenceCount} + 1`,
      })
      .where(
        and(
          eq(read.findings.workspaceId, p.workspaceId),
          eq(read.findings.repoId, p.repoId),
          eq(read.findings.scannerKey, p.scannerKey),
          inArray(read.findings.id, ids),
        ),
      );
    result.resighted += ids.length;
  }

  // ---- close what sat on a file the delta deleted ---------------------------
  // Selected by file, not by "seen by the base run": a finding an earlier
  // incremental left alone still points at a file that no longer exists.
  for (const files of chunks(deleted)) {
    const rows = await p.db
      .select({
        id: read.findings.id,
        file: read.findings.file,
        status: read.findings.status,
        workspaceId: read.findings.workspaceId,
        repoId: read.findings.repoId,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, p.workspaceId),
          eq(read.findings.repoId, p.repoId),
          eq(read.findings.scannerKey, p.scannerKey),
          inArray(read.findings.file, files),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      );
    for (const row of rows) {
      if (row.workspaceId !== p.workspaceId || row.repoId !== p.repoId) continue;
      if (row.file === null || !files.includes(row.file)) continue;
      const decision = autoResolveOutdated(row.status as FindingStatus);
      if (!decision) continue;
      await p.db
        .update(read.findings)
        .set({ status: decision.next, statusChangedAt: now })
        .where(eq(read.findings.id, row.id));
      await p.db.insert(read.findingEvents).values({
        workspaceId: p.workspaceId,
        findingId: row.id,
        fromStatus: row.status,
        toStatus: decision.next,
        actor: null,
        // 'outdated_diff', as a full sweep says it: we stopped seeing it because
        // the file is gone, which is not the same as someone fixing it.
        reason: decision.reason,
        scanRunId: p.newRunId,
      });
      result.closed += 1;
    }
  }

  return result;
}
