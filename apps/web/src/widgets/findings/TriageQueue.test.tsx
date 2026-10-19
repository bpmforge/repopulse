import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TriageQueue } from './TriageQueue.js';
import type { Finding } from './contracts.js';

// W16-52. `findings` is the explorer's LIVE list and each decision invalidates
// it, so the array shrank under the cursor while the index advanced: confirming
// item 1 of 3 landed on item 3, and the position counter walked backwards from
// "1 of 3" to "2 of 2". Every decision silently skipped the finding after it —
// on the screen whose entire purpose is not missing one.

// The mock ANSWERS, like the API does (W17-23): the queue now advances and
// counts on the server's success, not on the keypress, so a mutate that never
// calls back would leave every stepper test stuck on item one.
const mutate = vi.hoisted(() =>
  vi.fn((_body: unknown, opts?: { onSuccess?: () => void; onSettled?: () => void }) => {
    opts?.onSuccess?.();
    opts?.onSettled?.();
  }),
);
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

const THREE = [finding(1, 'first'), finding(2, 'second'), finding(3, 'third')];

/**
 * Confirm the current finding, THEN hand the component the shorter list its
 * parent now holds.
 *
 * The re-render is the whole test. Without it these assertions pass against the
 * broken component too — the bug only exists because the explorer's default
 * filter is `status: open`, so a confirmed finding leaves the list and the
 * array shifts under an index that has just moved forward. A harness with a
 * static prop reproduces nothing and proves nothing.
 */
function decideAndRefetch(
  rerender: (ui: React.ReactElement) => void,
  key: 'c' | 'd',
  remaining: Finding[],
): void {
  fireEvent.keyDown(window, { key });
  rerender(<TriageQueue findings={remaining} onExit={vi.fn()} invalidate={[]} />);
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

describe('the triage stepper (W16-52)', () => {
  it('moves to the NEXT finding after a decision, never past it', () => {
    const { rerender } = render(<TriageQueue findings={THREE} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    expect(screen.getByTestId('triage-position').textContent).toBe('1 of 3');

    decideAndRefetch(rerender, 'c', [THREE[1]!, THREE[2]!]);
    expect(mutate).toHaveBeenCalled();
    // The one immediately after, BY NAME. The broken version showed 'third'
    // here: index 1 into a list that had lost its head.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('second');
  });

  it('keeps the count still while someone works through it', () => {
    // "1 of 3" becoming "2 of 2" is the visible half of the skip, and it is
    // what makes a stepper feel untrustworthy even before anyone notices a
    // finding was missed.
    const { rerender } = render(<TriageQueue findings={THREE} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    decideAndRefetch(rerender, 'c', [THREE[1]!, THREE[2]!]);
    expect(screen.getByTestId('triage-position').textContent).toBe('2 of 3');
    decideAndRefetch(rerender, 'd', [THREE[2]!]);
    expect(screen.getByTestId('triage-position').textContent).toBe('3 of 3');
  });

  it('lets k go back to a finding already decided', () => {
    // Decided items stay in the run: someone who confirms by mistake has to be
    // able to return to it, and a queue that drops them cannot offer that.
    const { rerender } = render(<TriageQueue findings={THREE} onExit={vi.fn()} invalidate={[]} />);
    prepare();
    decideAndRefetch(rerender, 'c', [THREE[1]!, THREE[2]!]);
    fireEvent.keyDown(window, { key: 'k' });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('first');
  });
});
