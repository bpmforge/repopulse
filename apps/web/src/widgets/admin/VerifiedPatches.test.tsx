import { render, screen } from '@testing-library/react';
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
