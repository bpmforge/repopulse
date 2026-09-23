import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import type { DbOrTx } from './db.js';

// Per-page cursor checkpoint (FR-INGEST-3, INGESTION §3). Written in the SAME
// transaction as the page's upserts so a crash mid-backfill resumes from
// exactly the last committed page — never re-doing or skipping one.

export interface CursorState {
  cursorValue: string | null;
  backfillDone: boolean;
  /** W17-35: why the entity holds no data. Omitted = the fetch succeeded (null). */
  lastError?: string | null;
  /** W17-39: the feature is switched off on the repo. Omitted = false. */
  featureDisabled?: boolean;
}

export async function writeCursor(
  db: DbOrTx,
  scope: { workspaceId: number; repoId: number },
  entityType: string,
  state: CursorState,
): Promise<void> {
  await db
    .insert(core.syncCursors)
    .values({
      workspaceId: scope.workspaceId,
      repoId: scope.repoId,
      entityType,
      cursorValue: state.cursorValue,
      backfillDone: state.backfillDone,
      lastError: state.lastError ?? null,
      featureDisabled: state.featureDisabled ?? false,
    })
    .onConflictDoUpdate({
      target: [core.syncCursors.repoId, core.syncCursors.entityType],
      set: {
        cursorValue: state.cursorValue,
        backfillDone: state.backfillDone,
        lastError: state.lastError ?? null,
        featureDisabled: state.featureDisabled ?? false,
        updatedAt: new Date(),
      },
    });
}

export async function readCursor(
  db: DbOrTx,
  repoId: number,
  entityType: string,
): Promise<CursorState | null> {
  const [row] = await db
    .select({
      cursorValue: core.syncCursors.cursorValue,
      backfillDone: core.syncCursors.backfillDone,
    })
    .from(core.syncCursors)
    .where(and(eq(core.syncCursors.repoId, repoId), eq(core.syncCursors.entityType, entityType)))
    .limit(1);
  return row ?? null;
}
