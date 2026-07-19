import type { Job, Queue } from 'bullmq';
import { core, type Database } from '@repopulse/shared';
import { QUEUE } from './topology.js';

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
    error: error.message,
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
    { jobId: `dlq:${record.queue}:${record.jobId}`, removeOnComplete: false, removeOnFail: false },
  );
}
