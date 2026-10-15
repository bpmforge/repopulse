import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../__root.js';
import { Route as findingsRoute } from './index.js';
import { createQueryClient } from '../../api/queryClient.js';
import type { Finding, FindingFacets } from '../../widgets/findings/contracts.js';

// W18-29. Shadow findings (rules still being measured) are never mixed into the
// list silently: hidden by default WITH a count and a way to show them, marked
// on every row when shown, and filterable on their own. Rules are a facet,
// built from what findings carry, so fast-lane rules with no registry row are
// filterable too.

function finding(id: number, title: string, experimental: boolean, ruleId: string): Finding {
  return {
    id,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'slop',
    severity: 2,
    confidence: 3,
    title,
    file: `src/f${id}.ts`,
    line_range: [1, 1],
    evidence: 'e',
    recommendation: 'r',
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-10-01T00:00:00.000Z',
    last_seen_at: '2026-10-01T00:00:00.000Z',
    tier: 1,
    scanner_key: 'anti_slop',
    rule_id: ruleId,
    forge: null,
    experimental,
  };
}

const ACTIVE = finding(1, 'proven rule finding', false, 'slop.unused_export');
const SHADOW = finding(2, 'candidate rule finding', true, 'slop.phantom_ref');

const FACETS: FindingFacets = {
  rules: [
    {
      rule_id: 'slop.phantom_ref',
      scanner_key: 'anti_slop',
      active: 0,
      shadow: 1,
      lifecycle: null,
    },
    {
      rule_id: 'slop.unused_export',
      scanner_key: 'anti_slop',
      active: 1,
      shadow: 0,
      lifecycle: 'active',
    },
  ],
  shadow_total: 1,
};

function listFor(params: URLSearchParams) {
  const mode = params.get('experimental') ?? 'exclude';
  const rule = params.get('rule_id');
  const all = mode === 'only' ? [SHADOW] : mode === 'include' ? [ACTIVE, SHADOW] : [ACTIVE];
  const items = rule ? all.filter((f) => f.rule_id === rule) : all;
  const hidden = mode === 'exclude' ? (rule && rule !== SHADOW.rule_id ? 0 : 1) : null;
  return { items, next_cursor: null, experimental: mode, shadow_hidden: hidden };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://test');
    const p = url.pathname;
    let body: unknown = {};
    if (p.endsWith('/me/context')) body = { workspace: { id: 1 }, role: 'member' };
    else if (p.endsWith('/me/review-queue')) body = { items: [] };
    else if (p.endsWith('/findings/stats')) body = { total: 2, false_positive_rate: null };
    else if (p.endsWith('/findings/facets')) body = FACETS;
    else if (p.endsWith('/scanners'))
      body = { items: [{ key: 'anti_slop', display_name: 'Anti-slop' }] };
    else if (p.endsWith('/findings')) body = listFor(url.searchParams);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('innerWidth', 1440);
  // The router restores scroll on navigation; jsdom has no layout to scroll.
  vi.stubGlobal('scrollTo', () => {});
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => vi.unstubAllGlobals());

function renderExplorer() {
  const queryClient = createQueryClient();
  const route = findingsRoute.update({
    id: '/findings/',
    path: '/findings/',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof findingsRoute;
  const router = createRouter({
    routeTree: rootRoute.addChildren([route as never]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: ['/findings'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const listUrls = () =>
  fetchMock.mock.calls
    .map((c) => new URL(String(c[0]), 'http://test'))
    .filter((u) => u.pathname.endsWith('/findings'));

describe('the shadow facet (W18-29)', () => {
  it('lists active findings by default and says how many shadow ones it held back', async () => {
    renderExplorer();
    await screen.findByTestId('finding-1');
    expect(screen.queryByTestId('finding-2')).toBeNull();
    const note = await screen.findByTestId('shadow-hidden-note');
    expect(note).toHaveTextContent('1 finding from rules still in shadow matches these filters');
    // The default request carries no experimental param: the API's default.
    expect(listUrls()[0]!.searchParams.has('experimental')).toBe(false);
  });

  it('"Show them" lists both, and marks the shadow row — never mixed silently', async () => {
    renderExplorer();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('shadow-show'));
    const row = await screen.findByTestId('finding-2');
    expect(within(row).getByTestId('shadow-badge')).toHaveTextContent('shadow');
    expect(within(screen.getByTestId('finding-1')).queryByTestId('shadow-badge')).toBeNull();
    expect(screen.getByTestId('filter-shadow')).toHaveValue('include');
    expect(screen.queryByTestId('shadow-hidden-note')).toBeNull();
    await waitFor(() =>
      expect(listUrls().some((u) => u.searchParams.get('experimental') === 'include')).toBe(true),
    );
  });

  it('"Shadow rules only" asks for them alone and titles the list accordingly', async () => {
    renderExplorer();
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.selectOptions(screen.getByTestId('filter-shadow'), 'only');
    await screen.findByTestId('finding-2');
    expect(screen.queryByTestId('finding-1')).toBeNull();
    expect(screen.getByText('Shadow findings')).toBeInTheDocument();
  });

  it('offers the shadow count in the facet itself, before the click', async () => {
    renderExplorer();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Shadow rules only (1)' })).toBeInTheDocument(),
    );
  });
});

describe('the rule facet (W18-29)', () => {
  it('lists rules grouped by scanner with active and shadow counts kept apart', async () => {
    renderExplorer();
    const group = await screen.findByRole('group', { name: 'Anti-slop' });
    expect(within(group).getByRole('option', { name: 'slop.phantom_ref (1 shadow)' })).toBeTruthy();
    expect(
      within(group).getByRole('option', { name: 'slop.unused_export (1 active)' }),
    ).toBeTruthy();
  });

  it('filters by rule id', async () => {
    renderExplorer();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'slop.unused_export (1 active)' });
    await user.selectOptions(screen.getByTestId('filter-rule'), 'slop.unused_export');
    await waitFor(() =>
      expect(listUrls().some((u) => u.searchParams.get('rule_id') === 'slop.unused_export')).toBe(
        true,
      ),
    );
    // Nothing from shadow matches this rule, so there is nothing to announce.
    await waitFor(() => expect(screen.queryByTestId('shadow-hidden-note')).toBeNull());
  });

  it('an empty active list caused by the shadow default says so', async () => {
    renderExplorer();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'slop.phantom_ref (1 shadow)' });
    await user.selectOptions(screen.getByTestId('filter-rule'), 'slop.phantom_ref');
    expect(await screen.findByText(/come from rules still in shadow \(see above\)/)).toBeTruthy();
  });
});
