import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SensitiveChanges,
  radarBlankReason,
  type RadarItem,
  type SensitiveChangesResponse,
} from './SensitiveChanges.js';

// W18-29. The radar reads diffs as they arrive and never history, so a blank
// list has four causes and only one is good news. Each must say which; shadow
// signals must never sit in the review list.

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

const item = (id: number, over: Partial<RadarItem> = {}): RadarItem => ({
  id,
  repo: { id: 1, org: 'acme', name: 'payments' },
  severity: 3,
  title: 'Needs human review: CORS widened to any origin',
  file: 'src/app.ts',
  line: 4,
  rule_id: 'sensitive.cors_widened',
  status: 'open',
  pr_number: 12,
  first_seen_at: '2026-10-10T00:00:00.000Z',
  ...over,
});

const response = (over: Partial<SensitiveChangesResponse> = {}): SensitiveChangesResponse => ({
  repos: { total: 2, enabled: 2, disabled: [] },
  runs: {
    window_days: 30,
    recent: 14,
    failed: 0,
    ever: 40,
    last_finished_at: '2026-10-14T00:00:00.000Z',
  },
  rules: [
    {
      rule_id: 'sensitive.cors_widened',
      what: 'CORS widened to any origin',
      category: 'transport',
      lifecycle: 'active',
      open_active: 1,
      open_shadow: 0,
    },
    {
      rule_id: 'sensitive.rate_limit_raised',
      what: 'rate limit loosened',
      category: 'rate_limit',
      lifecycle: 'candidate',
      open_active: 0,
      open_shadow: 1,
    },
  ],
  totals: { active: 1, shadow: 1 },
  active: [item(1)],
  shadow: [
    item(2, {
      title: 'Needs human review: rate limit loosened',
      rule_id: 'sensitive.rate_limit_raised',
    }),
  ],
  ...over,
});

function renderWith(data: SensitiveChangesResponse) {
  useApiQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return render(<SensitiveChanges search={{}} />);
}

describe('radarBlankReason (W18-29)', () => {
  it('names each cause of a blank list, in order', () => {
    expect(radarBlankReason(response({ repos: { total: 0, enabled: 0, disabled: [] } }))).toMatch(
      /No repositories/,
    );
    expect(
      radarBlankReason(
        response({ repos: { total: 1, enabled: 0, disabled: [{ id: 1, org: 'a', name: 'p' }] } }),
      ),
    ).toMatch(/switched off for this repository/);
    expect(
      radarBlankReason(
        response({
          runs: { window_days: 30, recent: 0, failed: 0, ever: 0, last_finished_at: null },
        }),
      ),
    ).toMatch(/has not read a change yet/);
    expect(radarBlankReason(response())).toBeNull();
  });
});

describe('SensitiveChanges (W18-29)', () => {
  it('lists active signals for review and keeps shadow ones in their own closed section', () => {
    renderWith(response());
    const active = screen.getByTestId('radar-active-list');
    expect(within(active).getByText('CORS widened to any origin')).toBeInTheDocument();
    expect(within(active).queryByTestId('shadow-badge')).toBeNull();
    const shadow = screen.getByTestId('radar-shadow');
    expect(shadow.tagName).toBe('DETAILS');
    expect(shadow).not.toHaveAttribute('open');
    expect(within(shadow).getByTestId('shadow-badge')).toBeInTheDocument();
    expect(screen.getByTestId('radar-coverage')).toHaveTextContent(
      'Radar on for 2 of 2 repositories · 14 changes read in the last 30 days',
    );
  });

  it('says the radar has not read anything yet instead of "nothing found"', () => {
    renderWith(
      response({
        runs: { window_days: 30, recent: 0, failed: 0, ever: 0, last_finished_at: null },
        totals: { active: 0, shadow: 0 },
        active: [],
        shadow: [],
      }),
    );
    expect(screen.getByTestId('radar-unavailable')).toHaveTextContent('has not read a change yet');
    expect(screen.queryByTestId('radar-coverage')).toBeNull();
  });

  it('a clean result says how much was read', () => {
    renderWith(response({ totals: { active: 0, shadow: 0 }, active: [], shadow: [] }));
    expect(screen.getByTestId('radar-active')).toHaveTextContent(
      'Nothing loosened a protection: the radar read 14 changes in the last 30 days',
    );
  });

  it('an empty review list beside shadow signals points at them, not at a clean bill', () => {
    renderWith(response({ totals: { active: 0, shadow: 1 }, active: [] }));
    expect(screen.getByTestId('radar-active')).toHaveTextContent('No signal from an active rule');
    expect(screen.getByTestId('radar-shadow')).toBeInTheDocument();
  });

  it('names repositories the radar is off for', () => {
    renderWith(
      response({
        repos: { total: 3, enabled: 2, disabled: [{ id: 9, org: 'acme', name: 'legacy' }] },
      }),
    );
    expect(screen.getByTestId('radar-disabled-repos')).toHaveTextContent('radar is off for legacy');
  });

  it('shows every rule with its stage in words, and no score anywhere', () => {
    const { container } = renderWith(response());
    expect(screen.getByTestId('radar-rule-sensitive.rate_limit_raised')).toHaveTextContent(
      'Rate limit loosened · shadow · 1 open',
    );
    expect(container.textContent).not.toMatch(/score|grade/i);
  });
});

describe('Sensitive changes after triage (W20-13)', () => {
  it('splits confirmed changes from the ones still to review, with counts (FND-54)', () => {
    renderWith(
      response({
        active: [item(1), item(2, { status: 'confirmed' })],
        totals: { active: 2, shadow: 0 },
      }),
    );
    expect(screen.getByText('Needs human review (1)')).toBeInTheDocument();
    const confirmed = screen.getByTestId('radar-confirmed');
    expect(confirmed).toHaveTextContent('Confirmed, awaiting a fix (1)');
    expect(within(confirmed).getByTestId('radar-item-2')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('radar-active-list')).queryByTestId('radar-item-2'),
    ).toBeNull();
  });

  it('links to the rest in Findings when only the most recent are shown (FND-38)', () => {
    renderWith(response({ active: [item(1)], totals: { active: 30, shadow: 0 } }));
    expect(screen.getByTestId('radar-see-all')).toHaveTextContent('See all 30 in Findings');
  });

  it('says where the radar is switched back on (FND-39)', () => {
    renderWith(
      response({
        repos: { total: 2, enabled: 1, disabled: [{ id: 3, org: 'acme', name: 'web' }] },
      }),
    );
    expect(screen.getByTestId('radar-disabled-repos')).toHaveTextContent(/under Coverage/);
  });
});
