import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopActionsCard } from './TopActionsCard.js';
import type { TopActionItem, TopActionsResponse } from './contracts.js';

// W17-17. The card that put an ACTION above the fold on the landing screen.
//
// Two things it must never do: re-derive the server's deep link, and invent a
// number. Both are asserted below against the wire shape W17-16 ships.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));

// A Link that SYNTHESIZES an href from `to` + `search`, rather than the inert
// `href="#test"` stub the hotspot spec uses. The whole point of the deep-link
// assertion is that the URL the card builds equals the one the server sent, and
// a stubbed constant href would make that assertion vacuous.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: React.ReactNode;
  }) => {
    const params = new URLSearchParams(
      Object.entries(search ?? {}).map(([k, v]) => [k, String(v)]),
    ).toString();
    return (
      <a href={params ? `${to}?${params}` : to} {...rest}>
        {children}
      </a>
    );
  },
}));

const finding = (overrides: Partial<TopActionItem> = {}): TopActionItem => ({
  id: 'finding:42',
  kind: 'finding',
  title: 'Unbounded query in the report exporter',
  reason: 'Open reliability finding, risk 81.0 (act).',
  repo_id: 7,
  repo_name: 'payments',
  effort: null,
  target: { kind: 'finding', finding_id: 42, repo_id: 7 },
  href: '/findings?finding=42',
  ...overrides,
});

const planItem = (overrides: Partial<TopActionItem> = {}): TopActionItem => ({
  id: 'plan_item:9',
  kind: 'plan_item',
  title: 'Add review gates to the release branch',
  reason: 'Plan item ranked 1 in an active improvement plan.',
  repo_id: null,
  repo_name: null,
  effort: 'M',
  target: { kind: 'plan_item', plan_id: 3, plan_item_id: 9 },
  href: '/plans',
  ...overrides,
});

function renderWith(result: Partial<Record<string, unknown>>) {
  useApiQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...result,
  });
  return render(<TopActionsCard search={{ window: '90d' }} />);
}

function response(over: Partial<TopActionsResponse>): TopActionsResponse {
  return {
    actions: [],
    coverage: null,
    generated_at: '2026-09-10T12:00:00.000Z',
    ...over,
  };
}

describe('next actions card', () => {
  it('renders an action and deep-links to exactly the href the server sent', () => {
    renderWith({ data: response({ actions: [finding(), planItem()] }) });

    const findingLink = screen.getByTestId('top-action-finding:42');
    expect(findingLink).toHaveTextContent('Unbounded query in the report exporter');
    // The link is built from `target`, so this is the assertion that the two
    // cannot drift: a card that reconstructed /repos/7/findings?finding=42
    // would still "work" by eye and would not be the contract.
    expect(findingLink).toHaveAttribute('href', '/findings?finding=42');

    // A plan item has no per-item search param (W16-49: validateSearch REPLACES
    // the search object, so an invented key is stripped and the link opens
    // nothing). The global filters that /plans does accept still ride along.
    const planLink = screen.getByTestId('top-action-plan_item:9');
    expect(planLink.getAttribute('href')).toMatch(/^\/plans/);
    expect(planLink.getAttribute('href')).toContain('window=90d');
  });

  it('renders exactly the actions it was given — no padding to three', () => {
    renderWith({ data: response({ actions: [finding()] }) });
    expect(screen.getAllByTestId(/^top-action-/)).toHaveLength(1);
    // And no count is promised in the heading either.
    expect(screen.getByText('Next actions')).toBeInTheDocument();
    expect(screen.queryByText(/top 3|3 actions/i)).not.toBeInTheDocument();
  });

  it('shows a loading skeleton before any data arrives', () => {
    renderWith({ isLoading: true });
    expect(screen.getByTestId('widget-state-loading')).toBeInTheDocument();
  });

  it('reports a failure with its message rather than an empty card', () => {
    renderWith({ isError: true, error: new Error('upstream exploded') });
    expect(screen.getByTestId('widget-state-error')).toBeInTheDocument();
    expect(screen.getByText('upstream exploded')).toBeInTheDocument();
  });

  it('says NOTHING MEASURED rather than implying a clean result', () => {
    renderWith({
      data: response({
        coverage: {
          basis: 'none',
          repos_total: 4,
          repos_measured: 0,
          repos_never_measured: 4,
          repos_stale: 0,
          notices: [],
          unsupported: [],
          summary:
            'Nothing has been measured yet across 4 repositories — this is not a clean result, it is an absence of one.',
        },
      }),
    });

    expect(screen.getByTestId('top-actions-coverage')).toHaveAttribute('data-basis', 'none');
    expect(screen.getByText(/absence of one/)).toBeInTheDocument();
  });

  it('renders the healthy-measured state as measured, not as silence', () => {
    renderWith({
      data: response({
        coverage: {
          basis: 'full',
          repos_total: 9,
          repos_measured: 9,
          repos_never_measured: 0,
          repos_stale: 0,
          notices: [],
          unsupported: [],
          summary: 'No actions right now. 9 of 9 repositories have been measured.',
        },
      }),
    });

    expect(screen.getByTestId('top-actions-coverage')).toHaveAttribute('data-basis', 'full');
    expect(screen.getByText(/9 of 9 repositories have been measured/)).toBeInTheDocument();
    expect(screen.queryByTestId('top-actions-notices')).not.toBeInTheDocument();
  });

  it('renders the stale state', () => {
    renderWith({
      data: response({
        coverage: {
          basis: 'partial',
          repos_total: 5,
          repos_measured: 5,
          repos_never_measured: 0,
          repos_stale: 3,
          notices: [],
          unsupported: [],
          summary:
            'No actions right now. 5 of 5 repositories have been measured and 3 have not been measured recently.',
        },
      }),
    });

    expect(screen.getByText(/3 have not been measured recently/)).toBeInTheDocument();
  });

  it('tells the partial-failure state apart from the no-AI state', () => {
    // These two produce a BYTE-IDENTICAL coverage.summary: summaryFor() folds
    // both notice kinds into "1 capability is failing or not configured". A
    // card that rendered only the summary would show the same thing for a
    // broken scanner and for a workspace with no model configured — which is
    // exactly the confusion the coverage state exists to remove. The notices
    // are the discriminator, so they are what this asserts.
    const summary =
      'No actions right now. 2 of 2 repositories have been measured and 1 capability is failing or not configured.';
    const base = {
      basis: 'partial' as const,
      repos_total: 2,
      repos_measured: 2,
      repos_never_measured: 0,
      repos_stale: 0,
      unsupported: [],
      summary,
    };

    const failure = renderWith({
      data: response({
        coverage: {
          ...base,
          notices: [
            {
              repo_id: 1,
              repo_name: 'payments',
              capability: 'secrets_scan',
              state: 'failed',
              detail: 'tarball fetch timed out',
            },
          ],
        },
      }),
    });
    const failureText = screen.getByTestId('top-actions-notices').textContent ?? '';
    expect(failureText).toContain('secrets_scan');
    expect(failureText).toContain('failing');
    expect(failureText).toContain('tarball fetch timed out');
    failure.unmount();

    renderWith({
      data: response({
        coverage: {
          ...base,
          notices: [
            {
              repo_id: 1,
              repo_name: 'payments',
              capability: 'ai_review',
              state: 'not_configured',
              detail: 'no model configured',
            },
          ],
        },
      }),
    });
    const noAiText = screen.getByTestId('top-actions-notices').textContent ?? '';
    expect(noAiText).toContain('ai_review');
    expect(noAiText).toContain('not configured');
    // The two states must not render the same, even though the summary does.
    expect(noAiText).not.toEqual(failureText);
  });

  it('takes every total from the response — nothing about the demo data is baked in', () => {
    // Same card, two different warehouses. If any number here were a constant,
    // one of these two renders would be wrong.
    const first = renderWith({
      data: response({
        coverage: {
          basis: 'partial',
          repos_total: 3,
          repos_measured: 1,
          repos_never_measured: 2,
          repos_stale: 0,
          notices: [],
          unsupported: ['sbom'],
          summary: 'No actions right now. 1 of 3 repositories have been measured.',
        },
      }),
    });
    expect(screen.getByText(/1 of 3 repositories/)).toBeInTheDocument();
    expect(screen.getByTestId('top-actions-unsupported')).toHaveTextContent('sbom');
    first.unmount();

    renderWith({
      data: response({
        coverage: {
          basis: 'partial',
          repos_total: 41,
          repos_measured: 40,
          repos_never_measured: 1,
          repos_stale: 0,
          notices: [],
          unsupported: [],
          summary: 'No actions right now. 40 of 41 repositories have been measured.',
        },
      }),
    });
    expect(screen.getByText(/40 of 41 repositories/)).toBeInTheDocument();
    expect(screen.queryByText(/1 of 3 repositories/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('top-actions-unsupported')).not.toBeInTheDocument();
  });
});
