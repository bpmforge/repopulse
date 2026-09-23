import { describe, expect, it } from 'vitest';
import { ForgeBudgetParkedError } from '@repopulse/forge';
import { stallErrorText, withoutStallFragments } from './stall.js';
import { QUEUE } from './topology.js';

describe('stall fragments (W17-41)', () => {
  it('names the lane, the job and the cause, and tells a budget park from an error', () => {
    const error = stallErrorText(QUEUE.enrich, 'commitFiles', new Error('HTTP 502 upstream'));
    expect(error).toMatch(
      /^sync stalled — enrich job commitFiles failed after its retries: HTTP 502 upstream/,
    );

    const budget = stallErrorText(
      QUEUE.backfill,
      'commits',
      new ForgeBudgetParkedError('backfill', 'primary-floor', null),
    );
    expect(budget).toContain('backfill job commits gave up: forge rate-limit budget exhausted');
  });

  it('caps a long cause so one error cannot swamp the Admin → Sync column', () => {
    const text = stallErrorText(QUEUE.enrich, 'prDetail', new Error('x'.repeat(5000)));
    expect(text.length).toBeLessThan(400);
  });

  it('removes only stall fragments from a last_error line', () => {
    const refusal = 'reviews not ingested — HTTP 403: nope';
    const stall = stallErrorText(QUEUE.enrich, 'commitFiles', new Error('boom'));
    expect(withoutStallFragments(`${refusal} · ${stall}`)).toBe(refusal);
    expect(withoutStallFragments(stall)).toBeNull();
    expect(withoutStallFragments(null)).toBeNull();
  });
});
