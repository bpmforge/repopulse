import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageQueue } from './TriageQueue.js';
import type { Finding } from './contracts.js';

// The triage counters tell the truth (W17-23, acceptance 2).
//
// They used to move on the keypress. A refused decision — a 409 because a
// colleague got there first, a 400 because the note was blanked — still read
// "1 confirmed" in the session summary, and that summary is where the
// false-positive rate on the explorer comes from.

type Callbacks = {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
};
const pending = vi.hoisted<{ calls: Callbacks[] }>(() => ({ calls: [] }));
const mutate = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutate, isPending: false }),
}));

function finding(id: number, title: string): Finding {
  return {
    id,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title,
    file: 'src/a.ts',
    line_range: [10, 12],
    evidence: 'evidence',
    recommendation: 'fix it',
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
  } as unknown as Finding;
}

const TWO = [finding(1, 'first'), finding(2, 'second')];

beforeEach(() => {
  pending.calls = [];
  mutate.mockReset().mockImplementation((_body: unknown, opts: Callbacks) => {
    // Held, not answered: the test decides how the API replies.
    pending.calls.push(opts);
  });
});

function settle(i: number, outcome: 'ok' | { error: unknown }) {
  const cb = pending.calls[i]!;
  if (outcome === 'ok') cb.onSuccess?.();
  else cb.onError?.(outcome.error);
  cb.onSettled?.();
}

/**
 * W20-03 (FND-08): the queue starts with an empty note and no dismiss reason,
 * and refuses to decide until both are given. Every test here is about what
 * happens AFTER a decision, so it writes them first.
 */
function prepare() {
  fireEvent.change(screen.getByTestId('triage-note'), { target: { value: 'reviewed' } });
  fireEvent.change(screen.getByTestId('triage-reason'), { target: { value: 'not_applicable' } });
}

describe('the triage counters move on the server’s answer, not the keypress', () => {
  it('a refused decision counts nothing, shows why, and holds the cursor', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    fireEvent.keyDown(window, { key: 'c' });
    expect(mutate).toHaveBeenCalledTimes(1);
    // Nothing yet: the request is in flight.
    expect(screen.getByTestId('triage-summary').textContent).toMatch(/^0 confirmed · 0 dismissed/);
    expect(screen.getByTestId('triage-pending').textContent).toBe('Confirming…');

    act(() =>
      settle(0, {
        error: Object.assign(new Error('Transition not allowed'), { status: 409 }),
      }),
    );
    expect(screen.getByTestId('triage-summary').textContent).toMatch(/^0 confirmed · 0 dismissed/);
    expect(screen.getByTestId('triage-error').textContent).toMatch(/Transition not allowed/);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('first');
    expect(screen.getByTestId('triage-status').textContent).toBe('status open');
  });

  it('a successful decision counts once and advances', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    fireEvent.keyDown(window, { key: 'd' });
    act(() => settle(0, 'ok'));
    expect(screen.getByTestId('triage-summary').textContent).toMatch(/^0 confirmed · 1 dismissed/);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('second');
  });

  it('holds back only the same decision on the same finding while it is pending', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    fireEvent.keyDown(window, { key: 'c' });
    // A second c is a duplicate write and is dropped.
    fireEvent.keyDown(window, { key: 'c' });
    expect(mutate).toHaveBeenCalledTimes(1);
    // Moving on and deciding the NEXT finding is not, and must not wait.
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'c' });
    expect(mutate).toHaveBeenCalledTimes(2);

    // The first answer arrives after the cursor moved: it counts, and it does
    // not yank the cursor forward a second time.
    act(() => settle(0, 'ok'));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('second');
    expect(screen.getByTestId('triage-summary').textContent).toMatch(/^1 confirmed/);
  });
});
