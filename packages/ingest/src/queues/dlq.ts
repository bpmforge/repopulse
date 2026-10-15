import type { Job, Queue, Worker } from 'bullmq';
import { core, type Database, safeErrorText } from '@repopulse/shared';
import { QUEUE, safeJobId } from './topology.js';
import { markRepoStalled } from './stall.js';

// Dead-letter handling (NFR-11, INGESTION §6): when a job exhausts its
// attempts, copy it + the last error to the `ingest.dlq` queue AND a
// `job_failure` row (the admin ops page reads the row; the DLQ queue holds the
// replayable payload). Poison payloads never block the live queue.

export interface JobFailureRecord {
  workspaceId: number;
  queue: string;
  jobId: string;
  payload: unknown;
  error: string;
}

// A job is exhausted when it has failed on its final attempt. Pure so the
// predicate is unit-testable without a live worker.
export function isExhausted(attemptsMade: number, maxAttempts: number | undefined): boolean {
  return attemptsMade >= (maxAttempts ?? 1);
}

export function buildFailureRecord(
  queue: string,
  job: Pick<Job, 'id' | 'data'>,
  error: Error,
  workspaceId: number,
): JobFailureRecord {
  return {
    workspaceId,
    queue,
    jobId: job.id ?? 'unknown',
    payload: job.data,
    error: safeErrorText(error),
  };
}

/** Extract the workspaceId a job carries (all ingest payloads include it). */
export function workspaceIdOf(data: unknown): number | null {
  if (data && typeof data === 'object' && 'workspaceId' in data) {
    const wid = (data as { workspaceId: unknown }).workspaceId;
    if (typeof wid === 'number') return wid;
  }
  return null;
}

/**
 * Persist an exhausted job to the DLQ queue + job_failure ledger. Called from a
 * worker's `failed` listener only once attempts are exhausted (see isExhausted).
 */
export async function deadLetter(
  db: Database,
  dlqQueue: Queue,
  record: JobFailureRecord,
): Promise<void> {
  await db.insert(core.jobFailure).values({
    workspaceId: record.workspaceId,
    queue: record.queue,
    jobId: record.jobId,
    payload: record.payload,
    error: record.error,
  });
  await dlqQueue.add(
    QUEUE.dlq,
    {
      originalQueue: record.queue,
      originalJobId: record.jobId,
      payload: record.payload,
      error: record.error,
    },
    {
      jobId: safeJobId(`dlq-${record.queue}-${record.jobId}`),
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
}

/**
 * Wire a worker's `failed` event to the DLQ: on the FINAL failed attempt, copy
 * the poison job to the DLQ + job_failure ledger. Earlier attempts (still
 * retrying) are ignored — only exhausted jobs dead-letter (INGESTION §6). A
 * job with no resolvable workspaceId is skipped rather than crashing the
 * listener. An exhausted backfill/enrich job also moves its repo to `error`
 * (stall.ts), which the nightly sweep re-plans.
 */
export function attachDeadLetter(
  worker: Worker,
  dlqQueue: Queue,
  db: Database,
  onError?: (err: unknown) => void,
): void {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job || !isExhausted(job.attemptsMade, job.opts.attempts)) return;
    const workspaceId = workspaceIdOf(job.data);
    if (workspaceId === null) {
      onError?.(new Error(`DLQ skip: job ${job.id} has no workspaceId`));
      return;
    }
    void deadLetter(db, dlqQueue, buildFailureRecord(worker.name, job, err, workspaceId)).catch(
      (e: unknown) => onError?.(e),
    );
    // W17-41: a dead-lettered backfill/enrich job leaves its repo's initial
    // sync unfinished — say so on the repo instead of leaving it `backfilling`.
    // Independent of the ledger write above: either failing must not cost the other.
    void markRepoStalled(db, worker.name, job, err).catch((e: unknown) => onError?.(e));
  });
}
