import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCAN_POLL_MS,
  hasRunSince,
  newestRunAt,
  useScanRun,
  type ScanPayload,
} from './useScanRun.js';

// Following a manual scan to the end (W17-20).
//
// The property under test is not "it polls". It is that a spinner CANNOT
// outlive the job: every terminal state stops the poll and unlocks the button
// by construction, and a queued job that nobody picks up becomes a sentence
// rather than a permanent "Queued…".

const row = (key: string, state: string, last_run_at: string | null = null) => ({
  key,
  state,
  last_run_at,
});
const payload = (...scanners: ReturnType<typeof row>[]): ScanPayload => ({ scanners });

let clock: number;
beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const now = () => clock;

describe('useScanRun', () => {
  it('is idle over a table with nothing in flight', () => {
    const { result } = renderHook(() => useScanRun(payload(row('secrets', 'ok', '2026-09-01'))));
    expect(result.current.pending).toBe(false);
    expect(result.current.running).toEqual([]);
    expect(result.current.refetchInterval(payload(row('secrets', 'ok')))).toBe(false);
  });

  it('polls while the table shows a scan running, and names it', () => {
    const { result } = renderHook(() => useScanRun(payload(row('semgrep', 'running'))));
    expect(result.current.pending).toBe(true);
    expect(result.current.running).toEqual(['semgrep']);
    expect(result.current.refetchInterval(payload(row('semgrep', 'running')))).toBe(SCAN_POLL_MS);
  });

  it('stops the moment the running row reaches a terminal state', () => {
    // The whole ticket in one assertion: ok, error, partial, stale — none of
    // them is "running", so none of them keeps the poll alive.
    for (const terminal of ['ok', 'error', 'partial', 'stale', 'nothing_scanned', 'all_rejected']) {
      const { result, rerender } = renderHook(({ data }) => useScanRun(data), {
        initialProps: { data: payload(row('semgrep', 'running')) },
      });
      expect(result.current.pending).toBe(true);
      rerender({ data: payload(row('semgrep', terminal, '2026-09-10T10:00:00Z')) });
      expect(result.current.pending, terminal).toBe(false);
      expect(result.current.refetchInterval(payload(row('semgrep', terminal))), terminal).toBe(
        false,
      );
    }
  });

  it('keeps polling after a 202 until the job is SEEN, then hands over to the table', () => {
    const before = payload(row('semgrep', 'never_run'));
    const { result, rerender } = renderHook(({ data }) => useScanRun(data, { now }), {
      initialProps: { data: before },
    });
    act(() => result.current.onStarted());
    // Nothing is running yet — the worker has not inserted its row — but the
    // start was accepted, so the screen must keep asking.
    expect(result.current.awaiting).toBe(true);
    expect(result.current.pending).toBe(true);
    expect(result.current.refetchInterval(before)).toBe(SCAN_POLL_MS);

    rerender({ data: payload(row('semgrep', 'running', '2026-09-10T10:00:00Z')) });
    expect(result.current.awaiting).toBe(false);
    expect(result.current.running).toEqual(['semgrep']);
    expect(result.current.pending).toBe(true);

    rerender({ data: payload(row('semgrep', 'ok', '2026-09-10T10:02:00Z')) });
    expect(result.current.pending).toBe(false);
    expect(result.current.refetchInterval(payload(row('semgrep', 'ok')))).toBe(false);
  });

  it('settles on a run NEWER than any known at the click, even if it was never seen running', () => {
    // A fast scan can start and finish between two polls. The proof it ran
    // is a last_run_at later than the one the screen had when the button was
    // pressed — not the absence of a running row, which was also true before.
    const before = payload(row('secrets', 'ok', '2026-09-10T09:00:00Z'));
    const { result, rerender } = renderHook(({ data }) => useScanRun(data, { now }), {
      initialProps: { data: before },
    });
    act(() => result.current.onStarted());
    // Same payload again: NOT settled. Old news is not the answer.
    rerender({ data: before });
    expect(result.current.awaiting).toBe(true);

    rerender({ data: payload(row('secrets', 'ok', '2026-09-10T09:05:00Z')) });
    expect(result.current.awaiting).toBe(false);
    expect(result.current.pending).toBe(false);
  });

  it('gives up waiting for pickup after the timeout and says so, unlocking the button', () => {
    const before = payload(row('semgrep', 'never_run'));
    const { result, rerender } = renderHook(
      ({ data }) => useScanRun(data, { now, pickupTimeoutMs: 10_000 }),
      {
        initialProps: { data: before },
      },
    );
    act(() => result.current.onStarted());
    expect(result.current.awaiting).toBe(true);

    clock += 10_001;
    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    rerender({ data: before });
    expect(result.current.awaiting).toBe(false);
    expect(result.current.stalled).toBe(true);
    // Terminal, from the screen's point of view: nothing is in flight, so a
    // retry is allowed, and the poll is off.
    expect(result.current.pending).toBe(false);
    expect(result.current.refetchInterval(before)).toBe(false);
  });

  it('a fresh start clears a previous stall', () => {
    const before = payload(row('semgrep', 'never_run'));
    const { result } = renderHook(() => useScanRun(before, { now, pickupTimeoutMs: 1_000 }));
    act(() => result.current.onStarted());
    clock += 2_000;
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.stalled).toBe(true);
    act(() => result.current.onStarted());
    expect(result.current.stalled).toBe(false);
    expect(result.current.awaiting).toBe(true);
  });
});

describe('the helpers', () => {
  it('newestRunAt picks the latest timestamp across rows, or null', () => {
    expect(newestRunAt(undefined)).toBeNull();
    expect(newestRunAt(payload(row('a', 'never_run')))).toBeNull();
    expect(
      newestRunAt(
        payload(row('a', 'ok', '2026-09-01T00:00:00Z'), row('b', 'ok', '2026-09-03T00:00:00Z')),
      ),
    ).toBe('2026-09-03T00:00:00Z');
  });

  it('hasRunSince treats a null baseline as "any run at all"', () => {
    expect(hasRunSince(payload(row('a', 'never_run')), null)).toBe(false);
    expect(hasRunSince(payload(row('a', 'ok', '2026-09-01T00:00:00Z')), null)).toBe(true);
    expect(
      hasRunSince(payload(row('a', 'ok', '2026-09-01T00:00:00Z')), '2026-09-01T00:00:00Z'),
    ).toBe(false);
    expect(
      hasRunSince(payload(row('a', 'ok', '2026-09-01T00:00:01Z')), '2026-09-01T00:00:00Z'),
    ).toBe(true);
  });
});
