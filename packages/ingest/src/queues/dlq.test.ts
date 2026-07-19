import { describe, expect, it } from 'vitest';
import { buildFailureRecord, isExhausted, workspaceIdOf } from './dlq.js';

describe('DLQ pure logic (INGESTION §6, NFR-11)', () => {
  it('isExhausted only once the final attempt has failed', () => {
    expect(isExhausted(4, 5)).toBe(false);
    expect(isExhausted(5, 5)).toBe(true);
    expect(isExhausted(1, undefined)).toBe(true); // default 1 attempt
  });

  it('buildFailureRecord captures queue, jobId, payload and error message', () => {
    const rec = buildFailureRecord(
      'ingest.backfill',
      { id: 'bf:7:prs', data: { repoId: 7, workspaceId: 3 } },
      new Error('boom'),
      3,
    );
    expect(rec).toEqual({
      workspaceId: 3,
      queue: 'ingest.backfill',
      jobId: 'bf:7:prs',
      payload: { repoId: 7, workspaceId: 3 },
      error: 'boom',
    });
  });

  it('workspaceIdOf reads the workspaceId every ingest payload carries', () => {
    expect(workspaceIdOf({ workspaceId: 42, repoId: 1 })).toBe(42);
    expect(workspaceIdOf({ repoId: 1 })).toBeNull();
    expect(workspaceIdOf(null)).toBeNull();
  });
});
