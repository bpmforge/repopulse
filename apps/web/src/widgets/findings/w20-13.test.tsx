import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { TriageQueue } from './TriageQueue.js';
import { skippedByReason } from './BulkActions.js';
import type { Finding } from './contracts.js';

// W20-13: the finding panel's metadata and messages (FND-23 / FND-24 /
// FND-25 / FND-74), the triage queue's location, decided status and shortcut
// switch (FND-35 / FND-72 / FND-34), and the bulk result's summary (FND-22).

type Opts = { onSuccess?: () => void; onError?: (e: unknown) => void; onSettled?: () => void };
const calls = vi.hoisted<{ list: { body: unknown; opts: Opts | undefined }[] }>(() => ({
  list: [],
}));
const mutationOptions = vi.hoisted<{ list: unknown[] }>(() => ({ list: [] }));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: (_d: unknown, options: unknown) => {
    mutationOptions.list.push(options);
    return {
      mutate: (body: unknown, opts?: Opts) => calls.list.push({ body, opts }),
      isPending: false,
      variables: undefined,
      error: null,
    };
  },
  useApiQuery: () => ({ data: { items: [] } }),
  queryKeyFor: (d: { endpoint: string }) => [d.endpoint],
}));

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 7,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'dependency',
    severity: 3,
    confidence: 4,
    title: 'CVE-2026-1 in lodash 4.17.20',
    file: null,
    line_range: [null, null],
    evidence: 'pkg:npm/lodash@4.17.20 is affected by CVE-2026-1',
    recommendation: 'Upgrade lodash.',
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-02T00:00:00.000Z',
    tier: 1,
    forge: null,
    cve_id: 'CVE-2026-1',
    kev: true,
    risk_band: 'act',
    effective_risk: 8.25,
    ...over,
  } as Finding;
}

beforeEach(() => {
  calls.list = [];
  mutationOptions.list = [];
});

describe('finding panel (W20-13)', () => {
  it('says the repository, CVE, KEV, risk and dates without a list around it (FND-23)', () => {
    render(<FindingDetail finding={finding()} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.getByTestId('finding-meta-repo')).toHaveTextContent('acme/payments');
    expect(screen.getByTestId('finding-meta-cve')).toHaveTextContent('CVE-2026-1');
    expect(screen.getByTestId('finding-meta-kev')).toHaveTextContent('known exploited');
    expect(screen.getByTestId('finding-meta-risk')).toHaveTextContent('Act now · 8.3');
    expect(screen.getByTestId('finding-meta-first-seen')).not.toBeEmptyDOMElement();
    expect(screen.getByTestId('finding-meta-last-seen')).not.toBeEmptyDOMElement();
    // A repository-level finding has no file page to link to.
    expect(screen.queryByTestId('finding-file-page')).toBeNull();
  });

  it('links a file finding to its file page (FND-70, part)', () => {
    render(
      <FindingDetail
        finding={finding({ file: 'src/a b.ts', line_range: [3, 3] })}
        onClose={vi.fn()}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('finding-file-page')).toHaveAttribute(
      'href',
      '/repos/1/files/src/a%20b.ts',
    );
  });

  it('explains the dismiss reason and names it in the message, focused (FND-24 / FND-25)', () => {
    render(<FindingDetail finding={finding()} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.getByTestId('finding-dismiss-reason-help')).toHaveTextContent(
      'false-positive rate',
    );
    fireEvent.change(screen.getByTestId('finding-dismiss-reason'), {
      target: { value: 'accepted_risk' },
    });
    expect(screen.getByTestId('finding-dismiss-reason-help')).toHaveTextContent(
      'reopens on the review date',
    );
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'accepted by the platform team until Q1' },
    });
    // W20-21 (FND-25): an accepted risk needs its review date.
    fireEvent.change(screen.getByTestId('finding-review-by'), { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByTestId('finding-dismiss'));
    act(() => calls.list[0]!.opts?.onSuccess?.());
    const message = screen.getByTestId('finding-change-status');
    expect(message).toHaveTextContent('Dismissed as accepted risk.');
    expect(message).toHaveFocus();
  });

  it('invalidates every by-id copy of a finding, not only the list (FND-74)', () => {
    render(<FindingDetail finding={finding()} onClose={vi.fn()} invalidate={[['list']]} />);
    const options = mutationOptions.list.find(
      (o): o is { invalidate: unknown[][] } =>
        typeof o === 'object' && o !== null && 'invalidate' in o,
    );
    expect(options?.invalidate).toContainEqual(['/findings/{id}']);
  });
});

describe('triage queue (W20-13)', () => {
  it('says "whole repository", not null:null, for a repository-level finding (FND-35)', () => {
    render(<TriageQueue findings={[finding()]} onExit={vi.fn()} invalidate={[]} />);
    expect(screen.getByTestId('triage-location')).toHaveTextContent('whole repository');
  });

  it('shows a decision the server accepted when you come back to it (FND-72)', () => {
    render(
      <TriageQueue
        findings={[finding(), finding({ id: 8, title: 'second' })]}
        onExit={vi.fn()}
        invalidate={[]}
      />,
    );
    fireEvent.change(screen.getByTestId('triage-note'), { target: { value: 'real' } });
    fireEvent.click(screen.getByTestId('triage-confirm'));
    act(() => calls.list[0]!.opts?.onSuccess?.());
    fireEvent.click(screen.getByTestId('triage-prev'));
    expect(screen.getByTestId('triage-status')).toHaveTextContent(
      'Status: Confirmed · decided this session',
    );
    expect(screen.getByTestId('triage-confirm')).toBeDisabled();
  });

  it('single-key shortcuts can be switched off; Escape still exits (FND-34)', () => {
    const onExit = vi.fn();
    render(
      <TriageQueue
        findings={[finding(), finding({ id: 8, title: 'second' })]}
        onExit={onExit}
        invalidate={[]}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
    fireEvent.click(screen.getByTestId('triage-shortcuts'));
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(screen.getByTestId('triage-position')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByTestId('triage-shortcuts'));
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(screen.getByTestId('triage-position')).toHaveTextContent('2 of 2');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onExit).toHaveBeenCalled();
  });
});

describe('bulk result (FND-22)', () => {
  it('counts skipped rows by reason, most common first', () => {
    expect(
      skippedByReason([
        { id: 1, reason: 'not found' },
        { id: 2, reason: 'already resolved' },
        { id: 3, reason: 'already resolved' },
      ]),
    ).toEqual([
      { reason: 'already resolved', ids: [2, 3] },
      { reason: 'not found', ids: [1] },
    ]);
  });
});
