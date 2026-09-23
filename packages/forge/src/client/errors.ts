import type { Lane } from '../types.js';

// Thrown when the primary or a secondary budget denies a request outright
// (never queued/waited on here - FR-INGEST-4 has the BullMQ job itself yield
// and reschedule when it catches this).
export class ForgeBudgetParkedError extends Error {
  constructor(
    readonly lane: Lane,
    readonly reason: 'primary-floor' | 'secondary-family' | 'graphql',
    readonly resumeAt: number | null,
  ) {
    super(`forge budget parked lane=${lane} reason=${reason} resumeAt=${resumeAt ?? 'unknown'}`);
    this.name = 'ForgeBudgetParkedError';
  }
}

/**
 * A list call answered with an HTTP error (W17-35).
 *
 * The adapters used to read any non-2xx body as "not an array, so zero items":
 * a 403 on /issues looked exactly like a repo with no issues, the entity
 * checkpointed backfill_done, and nothing recorded that it had never been
 * fetched. `status` is the field connect.ts already classifies smoke failures
 * by, and `entity` names what could not be read so the caller can say so.
 */
export class ForgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly entity: string,
    readonly detail: string | null,
  ) {
    super(`${entity}: forge answered HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ForgeHttpError';
  }

  /**
   * Retrying will not change the answer: the token lacks a scope, the resource
   * is gone or disabled, or the request is one the forge will not serve. 5xx,
   * 429 and anything unexpected are not in this set — those fail the job so
   * the queue retries and, if they persist, dead-letters it.
   */
  get permanent(): boolean {
    return PERMANENT_STATUSES.has(this.status);
  }
}

const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

/** The error body's human message, when the forge sent one (all three do: `message`). */
function detailOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300);
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  return null;
}

/**
 * Throw unless a LIST response is usable. 2xx and a 304 served from the ETag
 * cache pass; everything else becomes a ForgeHttpError. `emptyOn` lists the
 * statuses a forge uses to mean "there is nothing here" rather than "you may
 * not look" — 409 on /commits for an empty repository, on GitHub and Gitea.
 */
export function assertListOk(
  res: { status: number; body: unknown },
  entity: string,
  emptyOn: readonly number[] = [],
): 'ok' | 'empty' {
  if ((res.status >= 200 && res.status < 300) || res.status === 304) return 'ok';
  if (emptyOn.includes(res.status)) return 'empty';
  throw new ForgeHttpError(res.status, entity, detailOf(res.body));
}
