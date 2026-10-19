import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageQueue } from './TriageQueue.js';
import type { Finding } from './contracts.js';

// W20-03 (UX_TODO FND-08, FND-09, FND-10). The note started as boilerplate and
// `d` always dismissed as false positive; the queue worked only by keyboard;
// and after the last finding nothing said the page was done.

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

const TWO = [finding(1, 'first'), finding(2, 'second')];

beforeEach(() => mutate.mockClear());

describe('the note and the dismiss reason are the reviewer’s (FND-08)', () => {
  it('starts with an empty note and refuses to act until one is written', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    expect(screen.getByTestId('triage-note')).toHaveValue('');
    expect(screen.getByTestId('triage-confirm')).toBeDisabled();
    fireEvent.keyDown(window, { key: 'c' });
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('triage-hint')).toHaveTextContent(/Write a note first/);
  });

  it('a dismissal needs a reason, and sends the one chosen — not false positive', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    fireEvent.change(screen.getByTestId('triage-note'), { target: { value: 'dup of #4' } });
    fireEvent.keyDown(window, { key: 'd' });
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('triage-hint')).toHaveTextContent(/Choose a dismiss reason/);
    // Key 4 picks the fourth reason.
    fireEvent.keyDown(window, { key: '4' });
    expect(screen.getByTestId('triage-reason')).toHaveValue('duplicate');
    fireEvent.keyDown(window, { key: 'd' });
    expect(mutate).toHaveBeenCalledWith(
      { status: 'dismissed', note: 'dup of #4', dismiss_reason: 'duplicate' },
      expect.anything(),
    );
    expect(screen.getByTestId('triage-summary')).toHaveTextContent(
      '0 confirmed · 1 dismissed (0 as false positive)',
    );
  });
});

describe('visible buttons mirror the keys (FND-09)', () => {
  it('Next, Previous, Confirm and Dismiss work without a keyboard', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    fireEvent.click(screen.getByTestId('triage-next'));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('second');
    fireEvent.click(screen.getByTestId('triage-prev'));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('first');

    fireEvent.change(screen.getByTestId('triage-note'), { target: { value: 'real' } });
    fireEvent.click(screen.getByTestId('triage-confirm'));
    expect(mutate).toHaveBeenLastCalledWith(
      { status: 'confirmed', note: 'real' },
      expect.anything(),
    );
    fireEvent.change(screen.getByTestId('triage-reason'), { target: { value: 'false_positive' } });
    fireEvent.click(screen.getByTestId('triage-dismiss'));
    expect(mutate).toHaveBeenLastCalledWith(
      { status: 'dismissed', note: 'real', dismiss_reason: 'false_positive' },
      expect.anything(),
    );
  });
});

describe('the end of the page (FND-10)', () => {
  it('after the last finding, a summary offers the next page when there is one', () => {
    const onNextPage = vi.fn();
    render(
      <TriageQueue
        findings={TWO}
        onExit={vi.fn()}
        invalidate={[]}
        nextCursor="c2"
        onNextPage={onNextPage}
      />,
    );
    fireEvent.change(screen.getByTestId('triage-note'), { target: { value: 'ok' } });
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('End of this page');
    expect(screen.getByTestId('triage-summary')).toHaveTextContent('2 confirmed');
    fireEvent.click(screen.getByTestId('triage-next-page'));
    expect(onNextPage).toHaveBeenCalledWith('c2');
  });

  it('on the last page it says so and offers no next page', () => {
    render(<TriageQueue findings={TWO} onExit={vi.fn()} invalidate={[]} />);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('triage-end-note')).toHaveTextContent(/last page/);
    expect(screen.queryByTestId('triage-next-page')).toBeNull();
    // And it can go back to the last finding.
    fireEvent.click(screen.getByTestId('triage-back'));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('second');
  });
});
