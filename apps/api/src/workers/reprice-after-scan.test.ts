import { describe, expect, it } from 'vitest';
import { enqueueRepriceAfterScan, REPRICE_AFTER_SCAN_DELAY_MS } from './processors.js';

// 2026-10-27 walkthrough: ~19 scanners per "Run scans now" must collapse into
// one reprice per repository, run shortly after, not one per scanner.
describe('enqueueRepriceAfterScan', () => {
  it('queues one delayed reprice per repository per ten minutes', async () => {
    const added: { name: string; data: unknown; opts: { jobId: string; delay: number } }[] = [];
    const queue = { add: async (name: string, data: unknown, opts: never) => void added.push({ name, data, opts }) };
    const t0 = Date.UTC(2026, 9, 27, 21, 30, 5);
    await enqueueRepriceAfterScan(queue as never, { workspaceId: 1, repoId: 9 }, t0);
    await enqueueRepriceAfterScan(queue as never, { workspaceId: 1, repoId: 9 }, t0 + 4 * 60_000);
    await enqueueRepriceAfterScan(queue as never, { workspaceId: 1, repoId: 9 }, t0 + 11 * 60_000);
    await enqueueRepriceAfterScan(queue as never, { workspaceId: 1, repoId: 10 }, t0);

    const ids = added.map((a) => a.opts.jobId);
    expect(ids[0]).toBe(ids[1]); // same window: BullMQ ignores the re-add
    expect(ids[2]).not.toBe(ids[0]); // a later window prices again
    expect(ids[3]).not.toBe(ids[0]); // another repository is its own job
    expect(added[0]!.data).toEqual({ workspaceId: 1, repoId: 9, repriceOnly: true });
    expect(added[0]!.opts.delay).toBe(REPRICE_AFTER_SCAN_DELAY_MS);
  });
});
