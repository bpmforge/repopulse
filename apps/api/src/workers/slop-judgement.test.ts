import { describe, expect, it } from 'vitest';
import type { AntiSlopJudgement } from '@repopulse/security';
import { createJudgementLane, type JudgementOutcome } from './slop-judgement.js';

// W27-02: the anti-slop judgement runs after its scan job, one per repository.

const SUMMARY: AntiSlopJudgement = {
  calls: 1,
  judgment: 1,
  refuted: 0,
  unverified: 1,
  rejected: 0,
  findingsCreated: 1,
  remembered: 1,
  skipped: 0,
};

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('createJudgementLane (W27-02)', () => {
  it('hands off without waiting: the scan returns while the judgement is still running', async () => {
    const lane = createJudgementLane();
    const outcomes: JudgementOutcome[] = [];
    const g = gate();
    let finished = 0;
    const defer = lane.deferFor({
      workspaceId: 1,
      repoId: 7,
      finish: async () => {
        finished += 1;
      },
      report: (o) => outcomes.push(o),
    });
    defer(
      async () => {
        await g.promise;
        return SUMMARY;
      },
      { scanRunId: 42 },
    );
    // Returned synchronously; nothing reported yet.
    expect(outcomes).toEqual([]);
    g.open();
    await lane.idle();
    expect(outcomes).toEqual([{ scanRunId: 42, summary: SUMMARY }]);
    expect(finished).toBe(1);
  });

  it('runs one judgement at a time per repository, others alongside', async () => {
    const lane = createJudgementLane();
    const order: string[] = [];
    const first = gate();
    const report = () => {};
    const sameRepo = lane.deferFor({ workspaceId: 1, repoId: 7, report });
    const otherRepo = lane.deferFor({ workspaceId: 1, repoId: 8, report });
    sameRepo(
      async () => {
        order.push('a:start');
        await first.promise;
        order.push('a:end');
        return SUMMARY;
      },
      { scanRunId: 1 },
    );
    sameRepo(
      async () => {
        order.push('b:start');
        return SUMMARY;
      },
      { scanRunId: 2 },
    );
    otherRepo(
      async () => {
        order.push('other');
        return SUMMARY;
      },
      { scanRunId: 3 },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['a:start', 'other']);
    first.open();
    await lane.idle();
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b:start']);
  });

  it('a judgement that throws is reported, still finishes, and does not stop the next', async () => {
    const lane = createJudgementLane();
    const outcomes: JudgementOutcome[] = [];
    let finished = 0;
    const defer = lane.deferFor({
      workspaceId: 1,
      repoId: 7,
      finish: async () => {
        finished += 1;
      },
      report: (o) => outcomes.push(o),
    });
    defer(
      async () => {
        throw new Error('boom');
      },
      { scanRunId: 1 },
    );
    defer(async () => SUMMARY, { scanRunId: 2 });
    await lane.idle();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ scanRunId: 1 });
    expect('err' in outcomes[0]! && (outcomes[0].err as Error).message).toBe('boom');
    expect(outcomes[1]).toEqual({ scanRunId: 2, summary: SUMMARY });
    expect(finished).toBe(2);
  });
});
