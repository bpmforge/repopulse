import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import type { Finding, FindingEvent } from './contracts.js';

// Review actions are reliable (W17-23).
//
// The mutation hook is replaced with one whose state the test controls: what
// it reports as pending, which variables it was called with, and what error it
// holds. That is the only way to see the panel BETWEEN the click and the
// answer, which is where the two defects lived — both buttons went grey while
// one request ran, and a refused write vanished without a word.

interface MockMutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  variables: { status: string } | undefined;
  error: unknown;
}

const mutation = vi.hoisted<{ current: MockMutation }>(() => ({
  current: { mutate: vi.fn(), isPending: false, variables: undefined, error: null },
}));
const historyItems = vi.hoisted<{ current: FindingEvent[] }>(() => ({ current: [] }));

vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => mutation.current,
  useApiQuery: () => ({ data: { items: historyItems.current } }),
  queryKeyFor: () => [],
}));

function finding(overrides: Partial<Finding> = {}): Finding {
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
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    forge: {
      url: 'https://github.com/acme/payments/blob/abc/src/auth.ts#L10-L12',
      ref_kind: 'commit',
    },
    ...overrides,
  };
}

function renderPanel(f = finding()) {
  return render(<FindingDetail finding={f} onClose={vi.fn()} invalidate={[]} />);
}

beforeEach(() => {
  mutation.current = { mutate: vi.fn(), isPending: false, variables: undefined, error: null };
  historyItems.current = [];
});

describe('only the submitting action is disabled while pending (W17-23, acceptance 4)', () => {
  it('a pending confirm leaves Dismiss and Copy enabled', () => {
    mutation.current = {
      ...mutation.current,
      isPending: true,
      variables: { status: 'confirmed' },
    };
    renderPanel();
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'seen it before, harmless' },
    });
    expect(screen.getByTestId('finding-confirm')).toBeDisabled();
    expect(screen.getByTestId('finding-confirm').textContent).toMatch(/Confirming/);
    expect(screen.getByTestId('finding-dismiss')).toBeEnabled();
    expect(screen.getByTestId('finding-copy-summary')).toBeEnabled();
  });

  it('a pending dismiss leaves Confirm enabled', () => {
    mutation.current = {
      ...mutation.current,
      isPending: true,
      variables: { status: 'dismissed' },
    };
    renderPanel();
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'seen it before, harmless' },
    });
    expect(screen.getByTestId('finding-dismiss')).toBeDisabled();
    expect(screen.getByTestId('finding-confirm')).toBeEnabled();
  });
});

describe('a failed mutation does not falsely change the status (W17-23, acceptance 2)', () => {
  it('shows the refusal and keeps the status the server holds', () => {
    // A 409 as the client throws it: the finding was already resolved by
    // someone else, or the transition is not in the lifecycle table.
    const error = Object.assign(new Error('Transition not allowed'), {
      status: 409,
      detail: 'open → resolved is not a permitted transition',
    });
    mutation.current = { ...mutation.current, error };
    renderPanel(finding({ status: 'open' }));

    expect(screen.getByTestId('finding-action-error').textContent).toMatch(
      /Transition not allowed/,
    );
    // The chip is the server's answer, not the button's intent.
    expect(screen.getByTestId('finding-status').textContent).toBe('status open');
    expect(screen.queryByText(/status confirmed/)).toBeNull();
  });

  it('sends the note and dismiss reason the person entered, nothing optimistic', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'fixture code' } });
    fireEvent.change(screen.getByTestId('finding-dismiss-reason'), {
      target: { value: 'not_applicable' },
    });
    fireEvent.click(screen.getByTestId('finding-dismiss'));
    expect(mutation.current.mutate).toHaveBeenCalledWith(
      {
        status: 'dismissed',
        note: 'fixture code',
        dismiss_reason: 'not_applicable',
      },
      expect.anything(),
    );
    // Still open on screen: nothing changes until the list is re-read.
    expect(screen.getByTestId('finding-status').textContent).toBe('status open');
  });
});

describe('Copy review summary (W17-23, acceptance 3)', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    fetchSpy.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('puts usable plain text on the clipboard and writes nowhere else', async () => {
    historyItems.current = [
      {
        from_status: 'open',
        to_status: 'confirmed',
        actor: 3,
        actor_login: 'fixture-dev',
        automatic: false,
        reason: 'Reproduced.',
        at: '2026-08-02T10:00:00.000Z',
      },
    ];
    renderPanel(finding({ status: 'confirmed' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('finding-copy-summary'));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain('Finding #7: Unvalidated redirect');
    expect(text).toContain('Repository: acme/payments');
    expect(text).toContain('Location: src/auth.ts:10–12');
    expect(text).toContain('Status: confirmed');
    expect(text).toContain('https://github.com/acme/payments/blob/abc/src/auth.ts#L10-L12');
    expect(text).toContain('res.redirect(req.query.next)');
    expect(text).toContain('Allow-list the destination.');
    expect(text).toContain('2026-08-02 open → confirmed (fixture-dev: Reproduced.)');
    // Plain text: no markup, no markdown headings.
    expect(text).not.toMatch(/<[a-z]+>|^#|\*\*/m);

    // No forge write, no API call of any kind: the summary is assembled from
    // what the panel already has. The mutation hook was not touched either.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mutation.current.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('finding-copy-summary').textContent).toBe('Copied');
  });

  it('says so when the clipboard refuses, rather than claiming success', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId('finding-copy-summary'));
    });
    expect(screen.getByTestId('finding-copy-summary').textContent).toMatch(/Copy failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
