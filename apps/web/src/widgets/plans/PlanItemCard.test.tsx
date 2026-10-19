import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanItemCard } from './PlanItemCard.js';
import type { PlanItem, PlanItemStatus } from './contracts.js';

// W17-25. The card says WHY an item is where it is, from the evidence the
// verifier recorded — and offers no control that could move it to done.

const mutate = vi.fn();
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutate, isPending: false, error: null }),
  queryKeyFor: () => [],
}));

beforeEach(() => {
  mutate.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const STATUSES: PlanItemStatus[] = [
  'proposed',
  'accepted',
  'in_progress',
  'done',
  'regressed',
  'dismissed',
];
const names = { M5: 'Review coverage %' };

function item(
  status: PlanItemStatus,
  evidence: Record<string, unknown> = {},
  verifiedAt: string | null = null,
): PlanItem {
  return {
    id: 7,
    rank: 1,
    catalog_id: 'review-coverage-low',
    source: 'metric',
    recommendation: 'Adopt a review SLA',
    effort: 'M',
    status,
    evidence: { metricKeys: ['M5'], ...evidence },
    verify_criterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
    verified_at: verifiedAt,
  };
}

const checked = (outcome: 'holds' | 'broken' | 'unknown', observed: number | null) => ({
  lastVerification: { outcome, observed, checkedAt: '2026-09-10T02:00:00.000Z' },
});

describe('PlanItemCard has no human path to done (W17-25)', () => {
  it.each(STATUSES)('offers no done or verified control in %s', (status) => {
    render(<PlanItemCard item={item(status, checked('holds', 0.9))} metricNames={names} />);
    const buttons = screen.queryAllByRole('button');
    for (const b of buttons) {
      expect(b.textContent).not.toMatch(/done|verified|complete/i);
    }
    expect(
      buttons.every((b) =>
        ['Accept', 'Dismiss…', 'Start', 'Restore'].includes(b.textContent ?? ''),
      ),
    ).toBe(true);
  });
});

// W20-05 (UX_TODO DSH-14). Dismiss was one click, with no reason and no undo.
describe('PlanItemCard dismissal is deliberate and reversible (W20-05)', () => {
  it('does not dismiss on the first click; it asks why', () => {
    render(<PlanItemCard item={item('proposed')} metricNames={names} />);
    fireEvent.click(screen.getByTestId('plan-dismiss-7'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-dismiss-form-7')).toBeInTheDocument();
    // No reason, no dismissal.
    expect(screen.getByTestId('plan-dismiss-confirm-7')).toBeDisabled();
  });

  it('sends the reason with the dismissal', () => {
    render(<PlanItemCard item={item('proposed')} metricNames={names} />);
    fireEvent.click(screen.getByTestId('plan-dismiss-7'));
    fireEvent.change(screen.getByTestId('plan-dismiss-reason-7'), {
      target: { value: 'Owned by platform' },
    });
    fireEvent.click(screen.getByTestId('plan-dismiss-confirm-7'));
    expect(mutate).toHaveBeenCalledWith(
      { status: 'dismissed', reason: 'Owned by platform' },
      expect.anything(),
    );
  });

  it('says what the dismissal will hide before it hides it (W20-09, DSH-57)', () => {
    render(<PlanItemCard item={item('proposed')} metricNames={names} scopeLabel="acme/web" />);
    fireEvent.click(screen.getByTestId('plan-dismiss-7'));
    expect(screen.getByTestId('plan-dismiss-scope-7')).toHaveTextContent(
      'Future plans for acme/web will not propose it again; plans for other repositories still can.',
    );
  });

  it('offers Restore on a dismissed item', () => {
    render(<PlanItemCard item={item('dismissed')} metricNames={names} />);
    fireEvent.click(screen.getByTestId('plan-restore-7'));
    expect(mutate).toHaveBeenCalledWith({ status: 'proposed' });
  });
});

describe('PlanItemCard explains progress (W17-25)', () => {
  const progress = () => screen.getByTestId('plan-item-progress-7').textContent ?? '';

  it('says accepted work has not been checked yet', () => {
    render(<PlanItemCard item={item('accepted')} metricNames={names} />);
    expect(progress()).toMatch(/not checked yet/i);
    expect(progress()).not.toMatch(/done|regress/i);
  });

  it('says in-progress work is open because of the number it last saw', () => {
    render(<PlanItemCard item={item('in_progress', checked('broken', 0.5))} metricNames={names} />);
    expect(progress()).toContain('0.5');
    expect(progress()).toContain('0.8');
    expect(progress()).toContain('Review coverage %');
    expect(progress()).toContain('2026-09-10');
  });

  it('says UNKNOWN when the metric was not measured, and that nothing will close', () => {
    render(
      <PlanItemCard item={item('in_progress', checked('unknown', null))} metricNames={names} />,
    );
    expect(progress()).toMatch(/not measured/i);
    expect(progress()).toMatch(/cannot close/i);
    expect(progress()).not.toMatch(/done/i);
  });

  it('says done because of the measured number, not because someone said so', () => {
    render(
      <PlanItemCard
        item={item('done', checked('holds', 0.9), '2026-09-10T02:00:00.000Z')}
        metricNames={names}
      />,
    );
    expect(progress()).toMatch(/^Done because/);
    expect(progress()).toContain('0.9');
    expect(progress()).toContain('0.8');
  });

  it('keeps done honest when the metric has since gone unmeasured', () => {
    render(
      <PlanItemCard
        item={item('done', checked('unknown', null), '2026-09-01T02:00:00.000Z')}
        metricNames={names}
      />,
    );
    expect(progress()).toContain('2026-09-01');
    expect(progress()).toMatch(/not measured/i);
    expect(progress()).not.toMatch(/regress/i);
  });

  it('says regressed because of the number that broke the criterion', () => {
    render(<PlanItemCard item={item('regressed', checked('broken', 0.3))} metricNames={names} />);
    expect(progress()).toMatch(/^Regressed because/);
    expect(progress()).toContain('0.3');
  });

  it('claims nothing for proposed work', () => {
    render(<PlanItemCard item={item('proposed', checked('holds', 0.9))} metricNames={names} />);
    expect(screen.queryByTestId('plan-item-progress-7')).not.toBeInTheDocument();
  });
});
