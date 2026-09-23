import { and, eq, inArray } from 'drizzle-orm';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { core, type Database } from '@repopulse/shared';
import { ForgeBudgetParkedError } from '@repopulse/forge';
import { QUEUE } from './topology.js';

// A sync that gave up must say so (W17-41, residual of W17-35/W17-38).
//
// A backfill or enrich job that exhausts its attempts (a 5xx that outlived the
// client's retries, a network error, a budget park longer than the backoff)
// was copied to the DLQ and nothing else: the PR/commit/entity it was working
// on stayed pending, so the repo stayed `backfilling` — indistinguishable from
// a sync that is still making progress. The repo now moves to `error` with a
// last_error fragment naming the job and the cause, and the nightly sweep's
// requeueErrorRepos re-plans it.

/** Queues whose dead letter leaves a repo's initial sync unfinished. */
const STALLING_QUEUES: ReadonlySet<string> = new Set([QUEUE.backfill, QUEUE.enrich]);

/** Only an in-flight initial sync is moved; a live repo is never downgraded. */
const IN_FLIGHT = ['pending_backfill', 'backfilling', 'paused_budget'];

const STALL_PREFIX = 'sync stalled';
const SEP = ' · ';
const MAX_CAUSE = 200;

/** The repos.last_error fragment for one dead-lettered job. */
export function stallErrorText(queue: string, jobName: string, err: Error): string {
  const budget = err instanceof ForgeBudgetParkedError || err.name === 'ForgeBudgetParkedError';
  const cause =
    err.message.length > MAX_CAUSE ? `${err.message.slice(0, MAX_CAUSE)}…` : err.message;
  const lane = queue.replace(/^ingest\./, '');
  return budget
    ? `${STALL_PREFIX} — ${lane} job ${jobName} gave up: forge rate-limit budget exhausted (${cause}); retried by the nightly sweep`
    : `${STALL_PREFIX} — ${lane} job ${jobName} failed after its retries: ${cause}; retried by the nightly sweep`;
}

/** Drop every stall fragment from a SEP-joined error line, keeping the rest. */
export function withoutStallFragments(line: string | null): string | null {
  const parts = (line ?? '')
    .split(SEP)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !p.startsWith(STALL_PREFIX));
  return parts.length > 0 ? parts.join(SEP) : null;
}

function repoIdOf(data: unknown): number | null {
  if (data && typeof data === 'object' && 'repoId' in data) {
    const id = (data as { repoId: unknown }).repoId;
    if (typeof id === 'number') return id;
  }
  return null;
}

/**
 * Move the job's repo to `error` if the dead-lettered job belonged to its
 * initial sync. Returns true when the repo was moved. The repo row is locked so
 * the fragment splice cannot race the entity-error writers (entity-error.ts).
 */
export async function markRepoStalled(
  db: Database,
  queue: string,
  job: Pick<Job, 'name' | 'data'>,
  err: Error,
): Promise<boolean> {
  if (!STALLING_QUEUES.has(queue)) return false;
  const repoId = repoIdOf(job.data);
  if (repoId === null) return false;
  const text = stallErrorText(queue, job.name, err);
  return db.transaction(async (tx) => {
    const [repo] = await tx
      .select({ lastError: core.repos.lastError })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), inArray(core.repos.syncStatus, IN_FLIGHT)))
      .for('update');
    if (!repo) return false;
    // First, because Admin → Sync truncates the line: the reason the repo is
    // in `error` must be what shows, ahead of any per-entity refusal.
    const kept = withoutStallFragments(repo.lastError);
    await tx
      .update(core.repos)
      .set({ syncStatus: 'error', lastError: kept ? `${text}${SEP}${kept}` : text })
      .where(eq(core.repos.id, repoId));
    return true;
  });
}

/**
 * Add a job under an idempotency key, replacing a FINISHED job that holds it.
 *
 * BullMQ ignores an add whose jobId already exists in any state, and the
 * topology keeps completed jobs (removeOnComplete: 1000) and failed ones
 * (removeOnFail: false). So a re-plan after a dead letter collapsed onto the
 * dead job and did nothing. topology.ts states the intended semantics — a
 * duplicate is a no-op "while it's queued/active" — and this is that: a
 * waiting, active, delayed or prioritized job still absorbs the add; a
 * completed or failed one is removed first. Removing the failed original loses
 * nothing: dlq.ts already copied it to the DLQ queue and the job_failure row.
 */
export async function addReplacingFinished(
  queue: Queue,
  name: string,
  data: unknown,
  opts: JobsOptions & { jobId: string },
): Promise<void> {
  const existing = await queue.getJob(opts.jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') await existing.remove();
  }
  await queue.add(name, data, opts);
}
