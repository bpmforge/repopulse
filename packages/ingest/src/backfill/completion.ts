import { and, eq, inArray } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import type { DbOrTx } from './db.js';
import { PAGINATED_ENTITIES } from './backfill.js';

// "Is this repo's history backfill finished?" — the signal that was missing.
//
// Each entity job is independent and none of them can see the others, so no
// single job knows the repo is done. sync_cursors.backfill_done already records
// per-entity completion in the same transaction as the page's upserts
// (cursor.ts), so the answer is a read, not new bookkeeping. It simply had no
// reader: setRepoStatus was only ever called for 'paused_budget', which is why
// no repo had ever left pending_backfill.

/**
 * True once every repo-wide paginated entity has checkpointed its last page.
 * Scoped to PAGINATED_ENTITIES on purpose — enrichment-phase cursors
 * (reviews/pr_files/checks) are not part of the history phase.
 */
export async function isHistoryBackfillComplete(db: DbOrTx, repoId: number): Promise<boolean> {
  const rows = await db
    .select({
      entityType: core.syncCursors.entityType,
      backfillDone: core.syncCursors.backfillDone,
    })
    .from(core.syncCursors)
    .where(
      and(
        eq(core.syncCursors.repoId, repoId),
        inArray(core.syncCursors.entityType, [...PAGINATED_ENTITIES]),
      ),
    );

  // Every entity must be PRESENT and done. An entity with no cursor row has
  // never run, so a repo mid-fan-out must not read as complete.
  const done = new Set(rows.filter((r) => r.backfillDone).map((r) => r.entityType));
  return PAGINATED_ENTITIES.every((e) => done.has(e));
}
