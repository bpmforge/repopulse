import { describe, expect, it, vi } from 'vitest';
import { processBackfillJob, type BackfillJobData } from './processor.js';
import type { BackfillResult } from './backfill.js';

const jobData: BackfillJobData = {
  workspaceId: 1,
  repoId: 7,
  repo: 'acme/x',
  entityType: 'commits',
};

function deps(run: () => Promise<BackfillResult>) {
  // db/provider unused — `run` is injected, bypassing the real page loop.
  return {
    db: {} as never,
    provider: {} as never,
    enqueue: vi.fn(async () => {}),
    setRepoStatus: vi.fn(async () => {}),
    run,
    now: () => 1_000_000,
  };
}

describe('processBackfillJob (INGESTION §3/§6, FR-INGEST-4)', () => {
  it('does not re-enqueue when the entity is done', async () => {
    const d = deps(() => Promise.resolve({ pages: 3, itemsTotal: 30, done: true }));
    await processBackfillJob(d, jobData);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues with the checkpoint cursor when more pages remain', async () => {
    const d = deps(() =>
      Promise.resolve({ pages: 20, itemsTotal: 200, done: false, nextCursor: 'C21' }),
    );
    await processBackfillJob(d, jobData);
    expect(d.enqueue).toHaveBeenCalledWith({ ...jobData, cursor: 'C21' });
    expect(d.setRepoStatus).not.toHaveBeenCalled();
  });

  it('on the budget floor: flips repo to paused_budget and re-enqueues with delay-to-reset (no busy-wait)', async () => {
    const d = deps(() =>
      Promise.resolve({
        pages: 0,
        itemsTotal: 0,
        done: false,
        nextCursor: 'C5',
        parkedUntilMs: 1_000_600,
      }),
    );
    await processBackfillJob(d, jobData);
    expect(d.setRepoStatus).toHaveBeenCalledWith(7, 'paused_budget');
    expect(d.enqueue).toHaveBeenCalledWith({ ...jobData, cursor: 'C5' }, { delayMs: 600 });
  });

  it('clamps a past reset time to a non-negative delay', async () => {
    const d = deps(() =>
      Promise.resolve({ pages: 0, itemsTotal: 0, done: false, parkedUntilMs: 999_000 }),
    );
    await processBackfillJob(d, jobData);
    expect(d.enqueue).toHaveBeenCalledWith(jobData, { delayMs: 0 });
  });
});
