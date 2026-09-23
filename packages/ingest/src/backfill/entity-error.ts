import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import type { ForgeHttpError } from '@repopulse/forge';
import type { DbOrTx, Tx } from './db.js';

// Per-entity fetch failures (W17-35, W14-01 "no failure absorbed silently").
//
// A permanent refusal (a token without read:issue gets 403) is recorded in two
// places: sync_cursors.last_error is the per-entity truth, and repos.last_error
// carries the same text so the existing Admin → Sync column shows it. The repo
// line may already hold something else — the webhook-registration failure
// connect.ts writes — so this module edits only its own fragment of it.

const SEP = ' · ';

/** The text written for one entity, e.g. "issues not ingested — HTTP 403: …". */
export function entityErrorText(entity: string, err: ForgeHttpError): string {
  return `${entity} not ingested — HTTP ${err.status}${err.detail ? `: ${err.detail}` : ''}`;
}

/** Remove `drop` (if present) from a SEP-joined error line, then add `add`. */
export function spliceErrorLine(
  line: string | null,
  drop: string | null,
  add: string | null,
): string | null {
  const parts = (line ?? '')
    .split(SEP)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== drop);
  if (add !== null && !parts.includes(add)) parts.push(add);
  return parts.length > 0 ? parts.join(SEP) : null;
}

/**
 * Swap this entity's fragment in repos.last_error. The row lock serializes the
 * five concurrent entity jobs of one repo, so two failing entities cannot each
 * read the old line and overwrite the other's fragment.
 */
export async function updateRepoEntityError(
  tx: Tx,
  repoId: number,
  previous: string | null,
  next: string | null,
): Promise<void> {
  if (previous === next) return;
  const [repo] = await tx
    .select({ lastError: core.repos.lastError })
    .from(core.repos)
    .where(eq(core.repos.id, repoId))
    .for('update');
  if (!repo) return;
  const line = spliceErrorLine(repo.lastError, previous, next);
  if (line === repo.lastError) return;
  await tx.update(core.repos).set({ lastError: line }).where(eq(core.repos.id, repoId));
}

/** The entity's recorded failure, or null (no row yet, or the last fetch succeeded). */
export async function readEntityError(
  db: DbOrTx,
  repoId: number,
  entity: string,
): Promise<string | null> {
  const [row] = await db
    .select({ lastError: core.syncCursors.lastError })
    .from(core.syncCursors)
    .where(and(eq(core.syncCursors.repoId, repoId), eq(core.syncCursors.entityType, entity)))
    .limit(1);
  return row?.lastError ?? null;
}
