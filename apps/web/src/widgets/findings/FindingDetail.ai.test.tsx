import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import type { Finding } from './contracts.js';

// W19-10. Accepting an AI false-positive suggestion does NOT dismiss the finding.
// The drawer's "Dismiss it as a false positive" only prefills the existing form
// (reason, focus); the person writes the note and presses Dismiss, which is the
// existing PATCH /findings/:id and the only thing that moves the finding.

const transition = vi.hoisted(() => vi.fn());
const decide = vi.hoisted(() => vi.fn());

vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: (d: { endpoint: string }) => ({
    mutate: d.endpoint === '/findings/{id}' ? transition : decide,
    isPending: false,
    variables: undefined,
    error: null,
  }),
  useApiQuery: (d: { endpoint: string }) =>
    d.endpoint === '/findings/{id}/ai'
      ? {
          data: {
            raised_by: null,
            suggestions: [
              {
                id: 5,
                verdict: 'likely_false_positive',
                confidence: 4,
                rationale: 'constant',
                citations: [],
                vex: null,
                patch: { status: null, reason: null, diff: null },
                model: 'm',
                checklist_version: 'triage.v1',
                route: { providerName: 'LM Studio', model: 'm', linkIndex: 0 },
                pass_id: 1,
                created_at: '2026-10-18T10:00:00Z',
                decision: 'accepted',
                decided_by: 'ada',
                decided_at: '2026-10-18T11:00:00Z',
              },
            ],
          },
        }
      : { data: { items: [] } },
  queryKeyFor: () => [],
}));

const finding: Finding = {
  id: 7,
  repo: { id: 1, org: 'acme', name: 'payments' },
  dimension: 'security',
  severity: 4,
  confidence: 4,
  title: 'SQL built by concatenation',
  file: 'src/users.ts',
  line_range: [3, 3],
  evidence: 'x',
  recommendation: 'Parameterise.',
  status: 'open',
  dismiss_reason: null,
  occurrence_count: 1,
  verify_status: 'unverified',
  first_seen_at: '2026-08-01T00:00:00.000Z',
  last_seen_at: '2026-08-01T00:00:00.000Z',
  tier: 1,
  forge: null,
};

beforeEach(() => {
  transition.mockReset();
  decide.mockReset();
});

describe('accepting an AI false-positive suggestion', () => {
  it('prefills the dismiss form and focuses the note, and changes nothing by itself', () => {
    render(<FindingDetail finding={finding} onClose={vi.fn()} invalidate={[]} />);
    fireEvent.change(screen.getByTestId('finding-dismiss-reason'), {
      target: { value: 'duplicate' },
    });
    fireEvent.click(screen.getByTestId('ai-prefill-dismiss'));

    expect((screen.getByTestId('finding-dismiss-reason') as HTMLSelectElement).value).toBe(
      'false_positive',
    );
    expect(document.activeElement).toBe(screen.getByTestId('finding-note'));
    // Nothing was sent: not a status change, not a decision.
    expect(transition).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(screen.getByTestId('finding-status').textContent).toBe('Status: Open');
    // And Dismiss still needs the person's note.
    expect(screen.getByTestId('finding-dismiss')).toBeDisabled();
  });
});
