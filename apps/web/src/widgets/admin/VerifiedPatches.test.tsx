import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VerifiedPatches, type PatchAttempt, type PatchAttempts } from './VerifiedPatches.js';

// W18-29. Every verified-fix attempt with its outcome and, for the ones that
// did not verify, the reason. Empty and unavailable are different sentences:
// "nobody asked yet" is not "nothing can be drafted".

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    'data-testid': testId,
  }: {
    to: string;
    children: React.ReactNode;
    'data-testid'?: string;
  }) => (
    <a href={to} data-testid={testId}>
      {children}
    </a>
  ),
}));

const attempt = (id: number, over: Partial<PatchAttempt> = {}): PatchAttempt => ({
  id,
  finding_id: 100 + id,
  status: 'verified',
  reason_code: null,
  reason: null,
  model_id: 'qwen-local',
  tier: 2,
  created_at: '2026-10-12T09:00:00.000Z',
  finished_at: '2026-10-12T09:01:00.000Z',
  finding: { title: 'Unused export', file: 'src/a.ts' },
  repo: { id: 1, name: 'payments' },
  ...over,
});

function renderWith(data: PatchAttempts, configured = true) {
  useApiQuery.mockImplementation((d: { endpoint: string }) =>
    d.endpoint === '/admin/analysis'
      ? {
          data: {
            gateway: configured
              ? { configured: true }
              : { configured: false, reason: 'No Tier-2 model is configured.' },
          },
        }
      : { data, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  );
  return render(<VerifiedPatches />);
}

describe('VerifiedPatches (W18-29)', () => {
  it('splits attempts by outcome and gives the reason for each that did not verify', () => {
    renderWith({
      counts: { verified: 1, rejected: 1 },
      items: [
        attempt(1),
        attempt(2, {
          status: 'rejected',
          reason_code: 'new_finding',
          reason: 'The patch raised a new logging finding.',
        }),
      ],
    });
    expect(screen.getByTestId('patch-count-verified')).toHaveTextContent('1');
    expect(screen.getByTestId('patch-count-rejected')).toHaveTextContent('1');
    expect(screen.getByTestId('patch-count-failed')).toHaveTextContent('0');
    expect(screen.getByTestId('patch-reason-2')).toHaveTextContent('raised a new logging finding');
    expect(screen.queryByTestId('patch-reason-1')).toBeNull();
    expect(screen.getByTestId('patch-1')).toHaveTextContent('payments · src/a.ts · Tier 2');
  });

  it('empty: nobody has asked for a fix yet, and how one is asked for', () => {
    renderWith({ counts: {}, items: [] });
    expect(screen.getByTestId('patches-frame')).toHaveTextContent(
      'No fix has been drafted yet. A member asks for one from a finding’s panel',
    );
  });

  it('unavailable: no model, so no fix can be drafted — with the way to fix that', () => {
    renderWith({ counts: {}, items: [] }, false);
    const frame = screen.getByTestId('patches-unavailable-empty');
    expect(frame).toHaveTextContent(
      'No fix can be drafted yet: drafting needs a Tier-2 model, and none is configured.',
    );
    expect(screen.getByTestId('patches-configure-model')).toHaveAttribute('href', '/admin/models');
  });

  it('history stays readable when drafting has since become unavailable', () => {
    renderWith({ counts: { verified: 1 }, items: [attempt(1)] }, false);
    expect(screen.getByTestId('patches-unavailable')).toHaveTextContent(
      'New fixes cannot be drafted: drafting needs a Tier-2 model',
    );
    expect(screen.getByTestId('patch-1')).toBeInTheDocument();
  });

  it('a deleted finding keeps its attempt, named by id', () => {
    renderWith({
      counts: { failed: 1 },
      items: [attempt(3, { status: 'failed', finding: { title: null, file: null } })],
    });
    expect(screen.getByTestId('patch-3')).toHaveTextContent('Finding #103');
    expect(screen.getByTestId('patch-reason-3')).toHaveTextContent('No reason was recorded.');
  });
});

// W20-11 (UX_TODO AI-66): filters and paging past the hundred newest.
describe('VerifiedPatches filters (W20-11)', () => {
  const queries = () =>
    useApiQuery.mock.calls
      .map((c) => c[0] as { endpoint: string; query?: Record<string, string> })
      .filter((d) => d.endpoint === '/admin/patches');

  it('asks the API for one outcome, model or repository, and pages back by cursor', () => {
    renderWith({
      counts: { verified: 2 },
      items: [attempt(1)],
      models: ['qwen-local', 'gemini'],
      repos: [
        { id: 1, name: 'payments' },
        { id: 2, name: 'web' },
      ],
      next_cursor: '1',
    });
    expect(queries()[0]!.query).toBeUndefined();
    fireEvent.change(screen.getByTestId('patch-filter-status'), { target: { value: 'rejected' } });
    expect(queries().at(-1)!.query).toEqual({ status: 'rejected' });
    fireEvent.change(screen.getByTestId('patch-filter-model'), { target: { value: 'gemini' } });
    fireEvent.change(screen.getByTestId('patch-filter-repo'), { target: { value: '2' } });
    expect(queries().at(-1)!.query).toEqual({ status: 'rejected', model: 'gemini', repo_id: '2' });
    fireEvent.click(screen.getByTestId('patch-older'));
    expect(queries().at(-1)!.query).toMatchObject({ before: '1' });
    fireEvent.click(screen.getByTestId('patch-newer'));
    expect(queries().at(-1)!.query).not.toHaveProperty('before');
  });

  it('says when nothing matches the filters', () => {
    renderWith({ counts: { verified: 2 }, items: [], models: ['m'] });
    fireEvent.change(screen.getByTestId('patch-filter-status'), { target: { value: 'failed' } });
    expect(screen.getByTestId('patch-list-empty')).toHaveTextContent('No attempt matches');
  });
});
