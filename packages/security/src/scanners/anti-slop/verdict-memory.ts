import { and, eq, inArray, sql } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';

// Anti-slop verdict memory (W27-02).
//
// Every scheduled scan used to send every shadow candidate to the model again,
// so an unchanged wrapper was re-judged on every commit (outline: 24-30 min of
// model time per scan). A candidate the model has answered for is recorded
// here by its hash (candidates.ts `candidateHash`) and not sent again while
// its excerpt is unchanged. Rows are written only for candidates in a batch
// the model actually answered with parseable JSON: a failed or unparseable
// call leaves them unremembered, so the next scan asks again.

export type CandidateOutcome = 'confirmed' | 'silent';

/** Which of these hashes the model has already judged, for this repository. */
export async function judgedHashes(
  db: Database,
  workspaceId: number,
  repoId: number,
  hashes: readonly string[],
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const t = security.slopCandidateVerdicts;
  const out = new Set<string>();
  // Chunked: a monorepo's candidate list can pass the bind-parameter limit.
  for (let i = 0; i < hashes.length; i += 1000) {
    const rows = await db
      .select({ hash: t.candidateHash })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, workspaceId),
          eq(t.repoId, repoId),
          inArray(t.candidateHash, hashes.slice(i, i + 1000)),
        ),
      );
    for (const r of rows) out.add(r.hash);
  }
  return out;
}

export async function rememberVerdicts(
  db: Database,
  workspaceId: number,
  repoId: number,
  scanRunId: number,
  rows: readonly { hash: string; ruleId: string; file: string; outcome: CandidateOutcome }[],
): Promise<void> {
  // One row per hash: identical code twice in one file is one question, and
  // ON CONFLICT cannot touch the same row twice in one statement.
  const byHash = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (byHash.get(r.hash)?.outcome !== 'confirmed') byHash.set(r.hash, r);
  }
  if (byHash.size === 0) return;
  const t = security.slopCandidateVerdicts;
  await db
    .insert(t)
    .values(
      [...byHash.values()].map((r) => ({
        workspaceId,
        repoId,
        candidateHash: r.hash,
        ruleId: r.ruleId,
        file: r.file,
        outcome: r.outcome,
        scanRunId,
      })),
    )
    .onConflictDoUpdate({
      target: [t.workspaceId, t.repoId, t.candidateHash],
      set: {
        outcome: sql`excluded.outcome`,
        scanRunId: sql`excluded.scan_run_id`,
        judgedAt: sql`now()`,
      },
    });
}
