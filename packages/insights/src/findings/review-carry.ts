import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { autoResolveOutdated, type FindingStatus } from './lifecycle.js';

// Carry-forward for an INCREMENTAL PR re-review (W23-07).
//
// The new review sent only the changed hunks to the model, and what it raised
// went through persistFindings as usual (so those findings are already
// re-sighted or new, and have provenance on the new pass). Every OTHER open
// finding the base pass raised is decided here from evidence, not from the
// model's silence: if its quoted line is still in the PR's NEW full diff it is
// carried forward (last_seen moves, occurrence_count counts the pass, and the
// new pass gets a provenance row so the next push can carry it again); if the
// quote is gone, it is closed as 'outdated_diff', as a full sweep would.
//
// Only findings that are open or confirmed and that the base pass raised are
// touched - a dismissed or wont_fix finding stays as a person left it (D9a).
// Workspace and repo are in every WHERE and re-checked in memory (Law 5).

export interface PriorReviewFinding {
  id: number;
  file: string | null;
  evidence: string;
  status: string;
}

export interface ReviewCarryPlan {
  carry: number[];
  close: number[];
}

/**
 * Pure decision: of the base pass's findings that the new pass did not already
 * re-raise, which are carried and which closed. `quoteInDiff` says whether the
 * quote is still in the new full diff of that file.
 */
export function planReviewCarry(
  prior: readonly PriorReviewFinding[],
  alreadyOnNewPass: ReadonlySet<number>,
  quoteInDiff: (file: string, quote: string) => boolean,
): ReviewCarryPlan {
  const plan: ReviewCarryPlan = { carry: [], close: [] };
  for (const f of prior) {
    if (alreadyOnNewPass.has(f.id)) continue;
    if (f.status !== 'open' && f.status !== 'confirmed') continue;
    if (f.file !== null && quoteInDiff(f.file, f.evidence)) plan.carry.push(f.id);
    else plan.close.push(f.id);
  }
  return plan;
}

export interface CarryReviewParams {
  db: Database;
  workspaceId: number;
  repoId: number;
  baseAiPassRunId: number;
  newAiPassRunId: number;
  quoteInDiff: (file: string, quote: string) => boolean;
}

export interface CarryReviewResult {
  carried: number;
  closed: number;
}

export async function carryForwardReview(p: CarryReviewParams): Promise<CarryReviewResult> {
  const now = new Date();
  const base = await p.db
    .select({
      id: read.findings.id,
      file: read.findings.file,
      evidence: read.findings.evidence,
      status: read.findings.status,
      workspaceId: read.findings.workspaceId,
      repoId: read.findings.repoId,
      specialist: read.aiFindingProvenance.specialist,
      checklistVersion: read.aiFindingProvenance.checklistVersion,
      model: read.aiFindingProvenance.model,
      route: read.aiFindingProvenance.route,
    })
    .from(read.aiFindingProvenance)
    .innerJoin(read.findings, eq(read.findings.id, read.aiFindingProvenance.findingId))
    .where(
      and(
        eq(read.aiFindingProvenance.workspaceId, p.workspaceId),
        eq(read.aiFindingProvenance.aiPassRunId, p.baseAiPassRunId),
        eq(read.findings.workspaceId, p.workspaceId),
        eq(read.findings.repoId, p.repoId),
      ),
    );
  const mine = base.filter((r) => r.workspaceId === p.workspaceId && r.repoId === p.repoId);
  const onNew = await p.db
    .select({ findingId: read.aiFindingProvenance.findingId })
    .from(read.aiFindingProvenance)
    .where(
      and(
        eq(read.aiFindingProvenance.workspaceId, p.workspaceId),
        eq(read.aiFindingProvenance.aiPassRunId, p.newAiPassRunId),
      ),
    );
  const plan = planReviewCarry(
    mine,
    new Set(onNew.map((r) => r.findingId)),
    p.quoteInDiff,
  );

  const result: CarryReviewResult = { carried: 0, closed: 0 };
  if (plan.carry.length > 0) {
    await p.db
      .update(read.findings)
      .set({
        lastSeenAt: now,
        occurrenceCount: sql`${read.findings.occurrenceCount} + 1`,
      })
      .where(
        and(
          eq(read.findings.workspaceId, p.workspaceId),
          eq(read.findings.repoId, p.repoId),
          inArray(read.findings.id, plan.carry),
        ),
      );
    const byId = new Map(mine.map((r) => [r.id, r]));
    for (const id of plan.carry) {
      const r = byId.get(id)!;
      await p.db
        .insert(read.aiFindingProvenance)
        .values({
          workspaceId: p.workspaceId,
          findingId: id,
          aiPassRunId: p.newAiPassRunId,
          specialist: r.specialist,
          checklistVersion: r.checklistVersion,
          model: r.model,
          route: (r.route ?? null) as Record<string, unknown> | null,
        })
        .onConflictDoNothing();
    }
    result.carried = plan.carry.length;
  }

  const byId = new Map(mine.map((r) => [r.id, r]));
  for (const id of plan.close) {
    const row = byId.get(id)!;
    const decision = autoResolveOutdated(row.status as FindingStatus);
    if (!decision) continue;
    await p.db
      .update(read.findings)
      .set({ status: decision.next, statusChangedAt: now })
      .where(
        and(
          eq(read.findings.id, id),
          eq(read.findings.workspaceId, p.workspaceId),
          eq(read.findings.repoId, p.repoId),
        ),
      );
    await p.db.insert(read.findingEvents).values({
      workspaceId: p.workspaceId,
      findingId: id,
      fromStatus: row.status,
      toStatus: decision.next,
      actor: null,
      reason: decision.reason,
      scanRunId: null,
    });
    result.closed += 1;
  }
  return result;
}
