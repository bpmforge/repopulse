import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// Accepted risks come back for review (W20-21, UX_TODO FND-25).
//
// A dismissal as accepted risk used to be for ever: nothing carried a date, so
// a risk accepted "for this quarter" was still accepted three years later and
// nobody had looked again. An accepted-risk dismissal now carries `review_by`,
// and once that day has come the nightly reconcile reopens the finding with a
// history row that says why. A reopen is not an automatic judgement: it puts
// the finding back in front of a person, who decides again.

/** Reopens this workspace's accepted risks whose review date has come. Returns their ids. */
export async function reopenDueAcceptedRisks(
  db: Database,
  workspaceId: number,
  today: Date = new Date(),
): Promise<number[]> {
  const day = today.toISOString().slice(0, 10);
  const due = await db
    .select({ id: read.findings.id, reviewBy: read.findings.reviewBy })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.status, 'dismissed'),
        eq(read.findings.dismissReason, 'accepted_risk'),
        isNotNull(read.findings.reviewBy),
        lte(read.findings.reviewBy, day),
      ),
    );

  const reopened: number[] = [];
  for (const row of due) {
    const moved = await db.transaction(async (tx) => {
      // Guarded on the state just read, as a person's transition is: a finding
      // someone reopened by hand a moment ago is left alone.
      const updated = await tx
        .update(read.findings)
        .set({ status: 'open', statusChangedAt: today, statusChangedBy: null, reviewBy: null })
        .where(
          and(
            eq(read.findings.id, row.id),
            eq(read.findings.workspaceId, workspaceId),
            eq(read.findings.status, 'dismissed'),
          ),
        )
        .returning({ id: read.findings.id });
      if (updated.length === 0) return false;
      await tx.insert(read.findingEvents).values({
        workspaceId,
        findingId: row.id,
        fromStatus: 'dismissed',
        toStatus: 'open',
        actor: null,
        reason: `accepted risk due for review (review date ${row.reviewBy})`,
      });
      return true;
    });
    if (moved) reopened.push(row.id);
  }
  return reopened;
}
