import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { FINDING_ACTIONS, FINDING_TRANSITIONS, type Finding } from './contracts.js';

// The finding panel offers exactly the lifecycle's moves (W20-01, UX_TODO FND-01).
//
// Before this, the panel always showed Confirm and Dismiss: a confirmed finding
// could not be marked fixed, an open one could not be marked won't-fix, nothing
// could be reopened, and a dismissed finding answered both buttons with a 409.

const mutation = vi.hoisted(() => ({
  current: { mutate: vi.fn(), isPending: false, variables: undefined, error: null },
}));

vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => mutation.current,
  useApiQuery: () => ({ data: { items: [] } }),
  queryKeyFor: () => [],
}));

function finding(status: string): Finding {
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
  };
}

const ALL_ACTION_IDS = Object.values(FINDING_ACTIONS).map((a) => a.testId);

beforeEach(() => {
  mutation.current = { mutate: vi.fn(), isPending: false, variables: undefined, error: null };
});

describe('finding actions follow the lifecycle', () => {
  it.each(Object.entries(FINDING_TRANSITIONS))('from %s, offers exactly %j', (status, allowed) => {
    render(<FindingDetail finding={finding(status)} onClose={vi.fn()} invalidate={[]} />);
    const expected = allowed.map((to) => FINDING_ACTIONS[to].testId);
    for (const id of ALL_ACTION_IDS) {
      if (expected.includes(id)) expect(screen.getByTestId(id)).toBeInTheDocument();
      else expect(screen.queryByTestId(id)).toBeNull();
    }
    // The reason picker belongs to Dismiss and is hidden when Dismiss is.
    expect(screen.queryByTestId('finding-dismiss-reason') !== null).toBe(
      allowed.includes('dismissed'),
    );
  });

  it('a confirmed finding can be marked fixed', () => {
    render(<FindingDetail finding={finding('confirmed')} onClose={vi.fn()} invalidate={[]} />);
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'fixed in #12' } });
    fireEvent.click(screen.getByTestId('finding-resolve'));
    expect(mutation.current.mutate).toHaveBeenCalledWith(
      { status: 'resolved', note: 'fixed in #12' },
      expect.anything(),
    );
  });

  it('a dismissed finding can be reopened and offers nothing the API would refuse', () => {
    render(<FindingDetail finding={finding('dismissed')} onClose={vi.fn()} invalidate={[]} />);
    expect(screen.queryByTestId('finding-confirm')).toBeNull();
    fireEvent.change(screen.getByTestId('finding-note'), { target: { value: 'it is real' } });
    fireEvent.click(screen.getByTestId('finding-reopen'));
    expect(mutation.current.mutate).toHaveBeenCalledWith(
      { status: 'open', note: 'it is real' },
      expect.anything(),
    );
  });
});

describe('the web table matches the lifecycle the API enforces', () => {
  it('mirrors HUMAN in packages/insights/src/findings/lifecycle.ts', () => {
    // The web app does not depend on insights, so the table is repeated; this
    // reads the source of truth and fails the moment the two drift.
    const candidates = [
      path.resolve(process.cwd(), '../../packages/insights/src/findings/lifecycle.ts'),
      path.resolve(process.cwd(), 'packages/insights/src/findings/lifecycle.ts'),
    ];
    const file = candidates.find((c) => existsSync(c));
    if (!file) throw new Error(`lifecycle.ts not found; looked in: ${candidates.join(', ')}`);
    const src = readFileSync(file, 'utf8');
    const block = /const HUMAN[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
    const parsed: Record<string, string[]> = {};
    for (const m of block.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
      parsed[m[1]!] = [...m[2]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!);
    }
    expect(Object.keys(parsed).length).toBe(5);
    expect(parsed).toEqual(FINDING_TRANSITIONS);
  });
});
