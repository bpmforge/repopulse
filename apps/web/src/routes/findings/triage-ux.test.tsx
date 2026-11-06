import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../__root.js';
import { Route as findingsRoute, validateFindingsSearch } from './index.js';
import { createQueryClient } from '../../api/queryClient.js';
import type { Finding } from '../../widgets/findings/contracts.js';

// W20-03: Findings filters in the URL (FND-03, FND-04), the selection held to
// the page it was made on with a select-all (FND-12), a bulk bar with every
// lifecycle move, a dismiss reason and a confirm step (FND-11, FND-13), Undo
// after a bulk action (FND-02), and an honest triage label (FND-10).

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

function finding(id: number, status = 'open'): Finding {
  return {
    id,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title: `finding ${id}`,
    file: `src/f${id}.ts`,
    line_range: [10, 12],
    evidence: `evidence for ${id}`,
    recommendation: 'fix it',
    status,
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    scanner_key: null,
    rule_id: null,
    forge: null,
  } as unknown as Finding;
}

/** The list, keyed by cursor ('' is the first page). */
let pages: Record<string, { items: Finding[]; next_cursor: string | null; total?: number }>;
let posts: { url: string; body: Record<string, unknown> }[];
let bulkAnswer: (body: Record<string, unknown>) => unknown;

beforeEach(() => {
  pages = {
    '': { items: [finding(1), finding(2)], next_cursor: 'c2', total: 3 },
    c2: { items: [finding(3)], next_cursor: null, total: 3 },
  };
  posts = [];
  bulkAnswer = (body) => ({ applied: body.ids, skipped: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test');
      const p = url.pathname;
      let body: unknown = {};
      if (init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url: p, body: sent });
        body = p.endsWith('/findings/bulk') ? bulkAnswer(sent) : {};
      } else if (p.endsWith('/me/context')) body = ME_CONTEXT;
      else if (p.endsWith('/me/review-queue')) body = { items: [] };
      else if (p.endsWith('/auth/identity')) body = { state: 'linked', identity_id: 7 };
      else if (p.endsWith('/findings/stats')) body = { total: 3, false_positive_rate: null };
      else if (p.endsWith('/scanners')) body = { items: [] };
      else if (p.endsWith('/findings/ids')) body = { ids: [1, 2, 3], truncated: false, cap: 1000 };
      else if (p.endsWith('/findings')) {
        body = pages[url.searchParams.get('cursor') ?? ''] ?? { items: [], next_cursor: null };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('scrollTo', () => {});
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(initialUrl = '/findings') {
  const queryClient = createQueryClient();
  const route = findingsRoute.update({
    id: '/findings/',
    path: '/findings/',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof findingsRoute;
  const router = createRouter({
    routeTree: rootRoute.addChildren([route as never]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const param = (k: string) => new URLSearchParams(router.history.location.search).get(k);
  return { router, param };
}

const listRequests = () =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => new URL(String(c[0]), 'http://test'))
    .filter((u) => u.pathname.endsWith('/findings'));

describe('filters live in the URL (FND-03, FND-04)', () => {
  it('a drill-down with ?dimension=&repos= lands filtered, and the request says so', async () => {
    renderAt('/findings?repos=7&dimension=secrets');
    await screen.findByTestId('finding-1');
    expect(screen.getByTestId('filter-dimension')).toHaveValue('secrets');
    await waitFor(() => {
      const last = listRequests().at(-1)!;
      expect(last.searchParams.get('dimension')).toBe('secrets');
      expect(last.searchParams.get('repo_id')).toBe('7');
      expect(last.searchParams.get('status')).toBe('active');
    });
  });

  it('changing a filter writes the URL, and Back restores the previous filter', async () => {
    const { router, param } = renderAt();
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.selectOptions(screen.getByTestId('filter-status'), 'dismissed');
    await waitFor(() => expect(param('status')).toBe('dismissed'));
    await user.selectOptions(screen.getByTestId('filter-status'), '');
    await waitFor(() => expect(param('status')).toBe('any'));
    expect(screen.getByTestId('filter-status')).toHaveValue('');
    router.history.back();
    await waitFor(() => expect(screen.getByTestId('filter-status')).toHaveValue('dismissed'));
  });

  // W26-02: the Severity and Risk headers sort the list, and say which is on.
  it('sorts from the column headers and marks the sorted column', async () => {
    const { param } = renderAt();
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    expect(screen.getByTestId('sort-risk')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('sort-severity'));
    await waitFor(() => expect(param('sort')).toBe('severity'));
    expect(screen.getByTestId('sort-severity').closest('th')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await waitFor(() => expect(listRequests().at(-1)!.searchParams.get('sort')).toBe('severity'));
    await user.click(screen.getByTestId('sort-risk'));
    await waitFor(() => expect(param('sort')).toBeNull());
    expect(screen.getByTestId('sort-risk').closest('th')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('validates every filter and drops junk rather than failing', () => {
    expect(
      validateFindingsSearch({
        finding: '4',
        dimension: 'secrets',
        status: 'open',
        severity_min: '9',
        verify_status: 'confirmed',
        in_chain: 'true',
        experimental: 'sometimes',
        sort: 'severity',
      }),
    ).toEqual({
      finding: 4,
      status: 'open',
      dimension: 'secrets',
      verify_status: 'confirmed',
      in_chain: true,
      sort: 'severity',
    });
    expect(validateFindingsSearch({ dimension: 'nonsense', status: 'any' })).toEqual({
      status: 'any',
    });
  });
});

describe('selection belongs to the page it was made on (FND-12)', () => {
  it('the header box selects the page, and turning the page clears it', async () => {
    renderAt();
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.click(screen.getByTestId('finding-select-page'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByTestId('findings-next-page'));
    await screen.findByTestId('finding-3');
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect(screen.getByTestId('finding-select-page')).not.toBeChecked();
  });

  it('a filter change clears it too', async () => {
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-select-1'));
    expect(screen.getByTestId('bulk-bar')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('filter-severity'), '5');
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).toBeNull());
  });

  // W20-08 (UX_TODO FND-12): with the whole page ticked, "Select all N
  // matching" fetches every matching id under the same filters, and the bulk
  // action then sends all of them.
  it('selects every finding matching the filters, not just this page', async () => {
    renderAt();
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.click(screen.getByTestId('finding-select-page'));
    await user.click(screen.getByTestId('select-all-matching-button'));
    await screen.findByTestId('select-page-only');
    const idsCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => new URL(String(c[0]), 'http://test'))
      .find((u) => u.pathname.endsWith('/findings/ids'));
    expect(idsCall?.searchParams.get('status')).toBe('active');
    await user.type(screen.getByTestId('bulk-note'), 'checked');
    await user.click(screen.getByTestId('bulk-confirmed'));
    await waitFor(() =>
      expect(posts[0]).toEqual({
        url: '/api/v1/findings/bulk',
        body: { ids: [1, 2, 3], status: 'confirmed', note: 'checked' },
      }),
    );
  });
});

describe('the bulk bar (FND-11, FND-13, FND-02)', () => {
  it('offers every move the lifecycle allows, and dismissal needs a reason that is sent', async () => {
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-select-1'));
    const bar = screen.getByTestId('bulk-bar');
    // From open: confirm, won't fix, dismiss, and (W20-08, UX_TODO FND-58)
    // mark fixed — a person may close what they fixed without confirming it
    // first. Never reopen.
    expect(within(bar).getByTestId('bulk-confirmed')).toBeInTheDocument();
    expect(within(bar).getByTestId('bulk-wont_fix')).toBeInTheDocument();
    expect(within(bar).getByTestId('bulk-resolved')).toBeInTheDocument();
    expect(within(bar).queryByTestId('bulk-open')).toBeNull();

    await user.type(screen.getByTestId('bulk-note'), 'vendored code');
    expect(screen.getByTestId('bulk-dismissed')).toBeDisabled();
    await user.selectOptions(screen.getByTestId('bulk-dismiss-reason'), 'not_applicable');
    await user.click(screen.getByTestId('bulk-dismissed'));
    await waitFor(() =>
      expect(posts[0]).toEqual({
        url: '/api/v1/findings/bulk',
        body: {
          ids: [1],
          status: 'dismissed',
          note: 'vendored code',
          dismiss_reason: 'not_applicable',
        },
      }),
    );
    expect(await screen.findByTestId('bulk-result')).toHaveTextContent('Dismissed: applied to 1');
  });

  it('Undo puts a bulk dismissal back to open with a note that says so', async () => {
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-select-page'));
    await user.type(screen.getByTestId('bulk-note'), 'scanner noise');
    await user.selectOptions(screen.getByTestId('bulk-dismiss-reason'), 'false_positive');
    await user.click(screen.getByTestId('bulk-dismissed'));
    await user.click(await screen.findByTestId('bulk-undo'));
    await waitFor(() =>
      expect(posts[1]?.body).toEqual({ ids: [1, 2], status: 'open', note: 'Undo of bulk Dismiss' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('bulk-result')).toHaveTextContent(
        'Undone: 2 findings are back where they were.',
      ),
    );
  });

  it('a bulk confirmation has no way back, and says so instead of offering Undo', async () => {
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-select-1'));
    await user.type(screen.getByTestId('bulk-note'), 'real');
    await user.click(screen.getByTestId('bulk-confirmed'));
    expect(await screen.findByTestId('bulk-no-undo')).toHaveTextContent(
      /no way from confirmed back/,
    );
    expect(screen.queryByTestId('bulk-undo')).toBeNull();
  });

  it('dismissing more than five asks first, and Cancel sends nothing', async () => {
    pages[''] = {
      items: [1, 2, 3, 4, 5, 6].map((id) => finding(id)),
      next_cursor: null,
      total: 6,
    };
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-select-page'));
    await user.type(screen.getByTestId('bulk-note'), 'duplicate rows');
    await user.selectOptions(screen.getByTestId('bulk-dismiss-reason'), 'duplicate');
    await user.click(screen.getByTestId('bulk-dismissed'));
    const confirm = screen.getByTestId('bulk-dismiss-confirm');
    expect(confirm).toHaveTextContent('Dismiss 6 findings as duplicate?');
    expect(posts).toHaveLength(0);
    await user.click(screen.getByTestId('bulk-dismiss-confirm-no'));
    expect(posts).toHaveLength(0);

    await user.click(screen.getByTestId('bulk-dismissed'));
    fireEvent.click(screen.getByTestId('bulk-dismiss-confirm-yes'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.body.ids as number[]).length).toBe(6);
  });
});

describe('the triage label (FND-10)', () => {
  it('says the queue is this page, out of how many match', async () => {
    renderAt();
    await screen.findByTestId('finding-1');
    expect(screen.getByTestId('start-triage')).toHaveTextContent('Triage this page (2 of 3)');
  });

  it('"Continue with the next page" opens the queue on the next page', async () => {
    renderAt();
    const user = userEvent.setup();
    await screen.findByText('Triage this page (2 of 3)');
    await user.click(screen.getByTestId('start-triage'));
    await user.click(screen.getByTestId('triage-next'));
    await user.click(screen.getByTestId('triage-next'));
    await user.click(screen.getByTestId('triage-next-page'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('finding 3'),
    );
    expect(screen.getByTestId('triage-position')).toHaveTextContent('1 of 1');
  });
});
