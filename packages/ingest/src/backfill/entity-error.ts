import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import { ForgeHttpError } from '@repopulse/forge';
import { writeCursor } from './cursor.js';
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
    // NO KEY UPDATE, not UPDATE (W21-01): see recordEnrichmentOutcome.
    .for('no key update');
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

// ── Enrichment (W17-38, residual R-15) ──────────────────────────────────────
//
// The per-PR and per-commit detail fetches get the same treatment as the
// backfill lists, with one difference: they are keyed on a parent row, so a
// refusal cannot "finish the entity" by checkpointing a cursor. The caller
// marks the parent handled instead (PR enriched_at, commit
// stats_source='unavailable'), and the refusal is carried on a sync_cursors
// row for the entity — always backfill_done=true, so the sync-status phase
// never mistakes it for unfinished history.

export type EnrichmentEntity = 'reviews' | 'checks' | 'commit_files' | 'review_comments';

export type Fetched<T> = { value: T; refused?: undefined } | { refused: ForgeHttpError };

/**
 * Run one enrichment fetch. A permanent refusal (401/403/404/410/422) comes
 * back as `{ refused }` so the job can record it and carry on with the other
 * fetches; anything else — a 5xx that outlived the client's retries, a 429, a
 * network error, a budget park — is rethrown so the queue retries the job and
 * dead-letters it if it persists.
 */
export async function fetchOrRefusal<T>(fetch: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { value: await fetch() };
  } catch (err) {
    if (err instanceof ForgeHttpError && err.permanent) return { refused: err };
    throw err;
  }
}

/**
 * Record — or clear — an enrichment entity's refusal inside the caller's
 * transaction. The common case (fetched fine, nothing recorded) costs one read
 * and no lock; otherwise the repo row is locked BEFORE the recorded value is
 * re-read, so concurrent enrich jobs of one repo cannot interleave a
 * read-modify-write of repos.last_error.
 */
export async function recordEnrichmentOutcome(
  tx: Tx,
  scope: { workspaceId: number; repoId: number },
  entity: EnrichmentEntity,
  refused: ForgeHttpError | null,
): Promise<void> {
  const next = refused ? entityErrorText(entity, refused) : null;
  if (next === null && (await readEntityError(tx, scope.repoId, entity)) === null) return;
  await tx
    .select({ id: core.repos.id })
    .from(core.repos)
    .where(eq(core.repos.id, scope.repoId))
    // NO KEY UPDATE, not UPDATE (W21-01). Every enrich transaction has already
    // inserted reviews or check runs by now, and each of those foreign keys
    // holds a KEY SHARE lock on this repo row. FOR UPDATE conflicts with KEY
    // SHARE, so two PR jobs of one repo each waited for the other's KEY SHARE
    // and Postgres killed one as a deadlock — the job then sat out a 60-second
    // backoff and the repo stayed backfilling. NO KEY UPDATE still serializes
    // the read-modify-write below against itself (and is what the UPDATE of
    // repos.last_error takes anyway) but does not conflict with KEY SHARE.
    .for('no key update');
  const previous = await readEntityError(tx, scope.repoId, entity);
  if (previous === next) return;
  await writeCursor(tx, scope, entity, { cursorValue: null, backfillDone: true, lastError: next });
  await updateRepoEntityError(tx, scope.repoId, previous, next);
}
