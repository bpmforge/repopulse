import { describe, expect, it } from 'vitest';
import { defaultJobOptions, jobId, QUEUE, QUEUE_PRIORITY, RETRY } from './topology.js';

describe('queue topology (INGESTION §6, NFR-11)', () => {
  it('jobId builders match the §6 idempotency keys (BullMQ-safe `-`, not `:`)', () => {
    expect(jobId.backfillEntity(7, 'prs')).toBe('bf-7-prs');
    expect(jobId.delta('D1', 'commits')).toBe('dl-D1-commits');
    expect(jobId.push(7)).toBe('push-7');
    expect(jobId.enrich(7, 'abc')).toBe('en-7-abc');
    expect(jobId.reconcile(7, '20260718')).toBe('rc-7-20260718');
    expect(jobId.snapshot(7, '20260718')).toBe('snap-7-20260718');
    // BullMQ forbids ':' in custom ids — none of our keys may contain one.
    for (const id of [
      jobId.backfillEntity(7, 'prs'),
      jobId.delta('D1', 'x'),
      jobId.enrich(7, 'a'),
    ]) {
      expect(id).not.toContain(':');
    }
  });

  it('retry policies match the §6 table', () => {
    expect(RETRY[QUEUE.backfill]).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
    expect(RETRY[QUEUE.delta]).toMatchObject({ attempts: 3, backoff: { delay: 10_000 } });
    expect(RETRY[QUEUE.reconcile]).toMatchObject({ attempts: 2 });
  });

  it('priority orders delta > backfill > enrich > reconcile', () => {
    expect(QUEUE_PRIORITY[QUEUE.delta]).toBeLessThan(QUEUE_PRIORITY[QUEUE.backfill] as number);
    expect(QUEUE_PRIORITY[QUEUE.backfill]).toBeLessThan(QUEUE_PRIORITY[QUEUE.enrich] as number);
    expect(QUEUE_PRIORITY[QUEUE.enrich]).toBeLessThan(QUEUE_PRIORITY[QUEUE.reconcile] as number);
  });

  it('defaultJobOptions keeps failed jobs (so the DLQ can inspect them)', () => {
    const opts = defaultJobOptions(QUEUE.backfill);
    expect(opts.removeOnFail).toBe(false);
    expect(opts.attempts).toBe(5);
    expect(opts.priority).toBe(3);
  });
});
