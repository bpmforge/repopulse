import { eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';

// Re-keying stored findings after a normaliser change (W8-16).
//
// WHY THIS HAS TO EXIST. `dedup_key` is stored, and the next scan looks a
// finding up by recomputing it. Change the normaliser and every affected row
// becomes unreachable: the scan finds no match, inserts a NEW row, and the old
// one is swept as resolved. Occurrence counts, triage decisions and
// false-positive suppressions all detach from the finding they belong to —
// which is precisely the harm dedup.ts warns about for the W8-02 key change.
//
// So the fix ships with its migration. This recomputes the key for existing
// rows from the evidence already stored, in place, changing nothing else.
//
// It is IDEMPOTENT: a row whose key already matches is skipped, so running it
// twice is free and running it after a later normaliser change is the same
// operation again.

export interface RekeyResult {
  scanned: number;
  rewritten: number;
  /**
   * Rows that would collide after re-keying — two findings that USED to share
   * a key and now genuinely differ, or the reverse.
   *
   * Reported rather than silently resolved: a collision means two rows are
   * claiming one identity, and choosing which survives is a decision about
   * someone's triage history, not a detail for a migration to make quietly.
   */
  collisions: { keptId: number; droppedId: number; key: string }[];
}

export async function rekeyFindings(db: Database, workspaceId: number): Promise<RekeyResult> {
  const rows = await db
    .select({
      id: read.findings.id,
      repoId: read.findings.repoId,
      dimension: read.findings.dimension,
      file: read.findings.file,
      lineStart: read.findings.lineStart,
      evidence: read.findings.evidence,
      scannerKey: read.findings.scannerKey,
      ruleId: read.findings.ruleId,
      dedupKey: read.findings.dedupKey,
    })
    .from(read.findings)
    .where(eq(read.findings.workspaceId, workspaceId));

  const result: RekeyResult = { scanned: rows.length, rewritten: 0, collisions: [] };
  // (repoId, key) -> the row that already owns it, so a clash is detected
  // rather than thrown at the unique index.
  const taken = new Map<string, number>();

  for (const row of rows) {
    const next = dedupKey({
      dimension: row.dimension,
      file: row.file,
      lineStart: row.lineStart,
      evidenceQuote: row.evidence,
      scannerKey: row.scannerKey,
      ruleId: row.ruleId,
    });
    const slot = `${row.repoId}\0${next}`;
    const owner = taken.get(slot);

    if (owner !== undefined && owner !== row.id) {
      result.collisions.push({ keptId: owner, droppedId: row.id, key: next });
      continue;
    }
    taken.set(slot, row.id);

    if (next === row.dedupKey) continue;
    await db.update(read.findings).set({ dedupKey: next }).where(eq(read.findings.id, row.id));
    result.rewritten += 1;
  }

  return result;
}
