import { and, eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { rekeyFindings, type RekeyResult } from './rekey.js';

// Moving a scanner's findings to a different dimension (W9-16).
//
// WHY THIS HAS TO EXIST, and it is the same reason as rekey.ts. `dedupKey`
// hashes the dimension, so changing what a scanner emits makes every row it
// already stored unreachable: the next scan recomputes a key that matches
// nothing, inserts a duplicate, and the sweep resolves the original — taking
// its occurrence count, its triage decisions and its false-positive
// suppressions with it. A scanner whose dimension changes without this is a
// scanner that silently discards everyone's triage history.
//
// The order is not incidental. The dimension is UPDATED first and the key
// recomputed second, because rekeyFindings derives the key from the row's
// stored dimension — re-keying first would compute the old key again and
// change nothing.
//
// Idempotent: the update matches only rows still on the old dimension, and
// rekeyFindings skips rows whose key already agrees. Running it twice is free.

export interface RemapResult {
  /** Rows moved to the new dimension. */
  remapped: number;
  /** The re-key pass that follows, including any collisions it refused to resolve. */
  rekey: RekeyResult;
}

/**
 * Moves one scanner's stored findings to a new dimension and re-keys them.
 *
 * Scoped to a scannerKey rather than a dimension alone: `code_health` is
 * written by three scanners, and only anti_slop's rows are misfiled. A remap by
 * dimension would drag `code_health_tools` findings along with them.
 */
export async function remapScannerDimension(
  db: Database,
  params: {
    workspaceId: number;
    scannerKey: string;
    fromDimension: string;
    toDimension: string;
  },
): Promise<RemapResult> {
  const moved = await db
    .update(read.findings)
    .set({ dimension: params.toDimension })
    .where(
      and(
        eq(read.findings.workspaceId, params.workspaceId),
        eq(read.findings.scannerKey, params.scannerKey),
        eq(read.findings.dimension, params.fromDimension),
      ),
    )
    .returning({ id: read.findings.id });

  // Always run, even when nothing moved: an interrupted earlier attempt could
  // have updated dimensions and died before re-keying, and that half-applied
  // state is exactly the one that looks fine and silently duplicates on the
  // next scan.
  const rekey = await rekeyFindings(db, params.workspaceId);

  return { remapped: moved.length, rekey };
}

/**
 * The W9-16 migration: anti_slop's findings belong to `slop` (FR-CH-3,
 * CODE_HEALTH_SUITE.md §2) and were stored as `code_health` from W9-03.
 */
export async function remapAntiSlopDimension(
  db: Database,
  workspaceId: number,
): Promise<RemapResult> {
  return remapScannerDimension(db, {
    workspaceId,
    scannerKey: 'anti_slop',
    fromDimension: 'code_health',
    toDimension: 'slop',
  });
}
