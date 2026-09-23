import { describe, expect, it } from 'vitest';
import {
  performanceEmptyCopy,
  performanceReviewState,
  PERFORMANCE_REVIEW_DISCLAIMER,
  type CapabilityRow,
} from './performance.js';

// W17-21. Five kinds of "no findings listed" must fold to five different
// sentences, and a completed run must win over anything that happened after it.

const row = (over: Partial<CapabilityRow>): CapabilityRow => ({
  id: 'performance',
  label: 'performance',
  kind: 'scanner',
  state: 'succeeded',
  last_success_at: '2026-09-09T10:00:00Z',
  latest_run_id: 1,
  last_success_ref: 'abc123def4567890',
  stale: false,
  detail: '',
  ...over,
});

const aiOff = row({
  id: 'ai_review',
  label: 'AI code review',
  kind: 'ai_review',
  state: 'not_configured',
  last_success_at: null,
  latest_run_id: null,
  last_success_ref: null,
  detail: 'No model is enabled for this workspace.',
});

const aiIdle = row({
  ...aiOff,
  detail: 'A model is configured but has not reviewed this repository yet.',
});

describe('performanceReviewState', () => {
  it('is no_provider when no perf scanner row exists and no model is enabled', () => {
    expect(performanceReviewState([aiOff]).kind).toBe('no_provider');
    expect(performanceReviewState([]).kind).toBe('no_provider');
    expect(performanceReviewState(undefined).kind).toBe('no_provider');
  });

  it('is not_run when a model is enabled but has never reviewed this repo', () => {
    expect(performanceReviewState([aiIdle]).kind).toBe('not_run');
  });

  it('is measured after any completed run, and names who did it', () => {
    const s = performanceReviewState([row({}), aiOff]);
    expect(s.kind).toBe('measured');
    expect(s.measuredBy).toEqual(['performance']);
    expect(s.lastSuccessRef).toBe('abc123def4567890');
    expect(s.latestFailed).toBe(false);
  });

  it('keeps the old success when the latest attempt failed (W17-10 rule)', () => {
    const s = performanceReviewState([row({ state: 'failed', stale: true })]);
    expect(s.kind).toBe('measured');
    expect(s.latestFailed).toBe(true);
    expect(s.stale).toBe(true);
  });

  it('is failed only when nothing ever succeeded', () => {
    expect(
      performanceReviewState([
        row({ state: 'failed', last_success_at: null, last_success_ref: null }),
      ]).kind,
    ).toBe('failed');
  });

  it('is in_progress for a queued or running producer with no prior success', () => {
    expect(performanceReviewState([row({ state: 'running', last_success_at: null })]).kind).toBe(
      'in_progress',
    );
    expect(performanceReviewState([row({ state: 'queued', last_success_at: null })]).kind).toBe(
      'in_progress',
    );
  });

  it('never takes a ref from a run that did not succeed', () => {
    const s = performanceReviewState([
      row({ state: 'failed', last_success_at: null, last_success_ref: 'deadbeef' }),
      row({ id: 'ai_review', label: 'AI code review', kind: 'ai_review', last_success_ref: null }),
    ]);
    expect(s.kind).toBe('measured');
    expect(s.lastSuccessRef).toBeNull();
  });

  it('ignores capabilities that are not performance producers', () => {
    const meta = row({ id: 'metadata', label: 'metadata', kind: 'metadata' });
    expect(performanceReviewState([meta, aiOff]).kind).toBe('no_provider');
  });
});

describe('performanceEmptyCopy', () => {
  const states = (['no_provider', 'not_run', 'in_progress', 'failed', 'measured'] as const).map(
    (kind) =>
      performanceEmptyCopy({
        kind,
        measuredBy: kind === 'measured' ? ['performance'] : [],
        lastSuccessAt: kind === 'measured' ? '2026-09-09T10:00:00Z' : null,
        lastSuccessRef: null,
        stale: false,
        latestFailed: false,
      }),
  );

  it('is a different sentence for every state', () => {
    expect(new Set(states).size).toBe(states.length);
  });

  it('says "result" only for the measured state and "not a clean" for the rest', () => {
    const [noProvider, notRun, inProgress, failed, measured] = states as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(measured).toMatch(/a result, not an absence of measurement/);
    for (const s of [noProvider, notRun, inProgress, failed]) {
      expect(s).not.toMatch(/a result/);
      expect(s).toMatch(
        /nothing has looked|nothing is known|not been measured|nothing has been measured/i,
      );
    }
  });

  it('contains no numbers, and neither does the disclaimer — nothing here was timed', () => {
    for (const s of [...states, PERFORMANCE_REVIEW_DISCLAIMER]) expect(s).not.toMatch(/\d/);
    expect(PERFORMANCE_REVIEW_DISCLAIMER).toMatch(
      /not measured latency, CPU, throughput or memory/,
    );
  });
});
