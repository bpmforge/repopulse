import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { undoTargetFor, type Finding } from './contracts.js';

// Undo after a status change (W20-03, UX_TODO FND-02).
//
// A mis-click on Dismiss could only be reversed through the API. The panel now
// says what it did and offers Undo when the lifecycle has a way back, and says
// plainly when it has none.

type Opts = { onSuccess?: () => void };
const calls = vi.hoisted<{ list: { body: unknown; opts: Opts | undefined }[] }>(() => ({
  list: [],
}));
const mutation = vi.hoisted(() => ({
  current: {
    mutate: vi.fn((body: unknown, opts?: Opts) => {
      calls.list.push({ body, opts });
    }),
    isPending: false,
    variables: undefined,
    error: null,
  },
}));

vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => mutation.current,
  useApiQuery: () => ({ data: { items: [] } }),
  queryKeyFor: () => [],
}));

function finding(status: string, dismiss_reason: string | null = null): Finding {
  return {
    id: 7,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title: 'Unvalidated redirect',
    file: 'src/auth.ts',
    line_range: [10, 12],
    evidence: 'res.redirect(req.query.next)',
    recommendation: 'Allow-list the destination.',
    status,
    dismiss_reason,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    forge: null,
  };
}

beforeEach(() => {
  calls.list = [];
  mutation.current.mutate.mockClear();
});

/** The API said yes: run the success callback of call `i`. */
const succeed = (i: number) => act(() => calls.list[i]!.opts?.onSuccess?.());

describe('undo after a status change (FND-02)', () => {
  it('a dismissal can be undone, back to open, with a note that says so', () => {
    const { rerender } = render(
      <FindingDetail finding={finding('open')} onClose={vi.fn()} invalidate={[]} />,
    );
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'test code only' } });
    fireEvent.change(screen.getByTestId('finding-dismiss-reason'), {
      target: { value: 'not_applicable' },
    });
    fireEvent.click(screen.getByTestId('finding-dismiss'));
    succeed(0);
    // The list re-read the finding as dismissed.
    rerender(
      <FindingDetail
        finding={finding('dismissed', 'not_applicable')}
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('finding-change-status')).toHaveTextContent(
      'Dismissed as not applicable.',
    );
    // The note is cleared once the change landed.
    expect(screen.getByTestId('finding-note')).toHaveValue('');

    fireEvent.click(screen.getByTestId('finding-undo'));
    expect(calls.list[1]!.body).toEqual({ status: 'open', note: 'Undo of Dismiss' });
    succeed(1);
    expect(screen.getByTestId('finding-change-status')).toHaveTextContent(
      'Undone: the finding is open again.',
    );
  });

  it('undoing a reopen dismisses again with the reason it had', () => {
    const { rerender } = render(
      <FindingDetail
        finding={finding('dismissed', 'duplicate')}
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'oops' } });
    fireEvent.click(screen.getByTestId('finding-reopen'));
    succeed(0);
    rerender(<FindingDetail finding={finding('open')} onClose={vi.fn()} invalidate={[]} />);
    fireEvent.click(screen.getByTestId('finding-undo'));
    expect(calls.list[1]!.body).toEqual({
      status: 'dismissed',
      note: 'Undo of Reopen',
      dismiss_reason: 'duplicate',
    });
  });

  it('a confirmation has no way back, and the message says so instead of offering Undo', () => {
    const { rerender } = render(
      <FindingDetail finding={finding('open')} onClose={vi.fn()} invalidate={[]} />,
    );
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'real' } });
    fireEvent.click(screen.getByTestId('finding-confirm'));
    succeed(0);
    rerender(<FindingDetail finding={finding('confirmed')} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.queryByTestId('finding-undo')).toBeNull();
    expect(screen.getByTestId('finding-no-undo')).toHaveTextContent(
      /no way from confirmed back to open/,
    );
  });

  it('the message belongs to its finding, not to the next one opened in the same panel', () => {
    const { rerender } = render(
      <FindingDetail finding={finding('open')} onClose={vi.fn()} invalidate={[]} />,
    );
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'only test code' } });
    fireEvent.click(screen.getByTestId('finding-dismiss'));
    succeed(0);
    rerender(
      <FindingDetail finding={{ ...finding('open'), id: 8 }} onClose={vi.fn()} invalidate={[]} />,
    );
    expect(screen.queryByTestId('finding-change-status')).toBeNull();
  });
});

describe('undoTargetFor follows the lifecycle', () => {
  it.each([
    ['open', 'dismissed', 'open'],
    ['open', 'wont_fix', 'open'],
    ['dismissed', 'open', 'dismissed'],
    ['open', 'confirmed', null],
    ['confirmed', 'dismissed', null],
    ['confirmed', 'resolved', null],
  ])('%s → %s undoes to %s', (from, to, expected) => {
    expect(undoTargetFor(from, to)).toBe(expected);
  });
});
