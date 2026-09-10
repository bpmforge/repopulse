import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../__root.js';
import { Route as findingsRoute } from './index.js';
import { createQueryClient } from '../../api/queryClient.js';
import type { Finding } from '../../widgets/findings/contracts.js';

// W17-22. The selected finding is URL state at every viewport width, the URL
// is a history entry (back, forward, reload all land on the same screen), the
// overlay presentation hands focus back to the row Escape came from, paging
// keeps the selection, and a finding this workspace cannot see never leaves
// the previous one on screen.

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

function finding(id: number, title: string): Finding {
  return {
    id,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title,
    file: `src/f${id}.ts`,
    line_range: [10, 12],
    evidence: `evidence for ${id}`,
    recommendation: 'fix it',
    status: 'open',
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

interface Reply {
  status: number;
  body: unknown;
}

function problem(status: number, title: string): Reply {
  return { status, body: { type: 'about:blank', title, status } };
}

/** The list, keyed by cursor ('' is the first page). */
let pages: Record<string, { items: Finding[]; next_cursor: string | null }>;
/** GET /findings/:id — a reply, or a promise a test resolves when it chooses. */
let byId: Record<number, Reply | Promise<Reply>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function respond(raw: string): Promise<Reply> {
  const url = new URL(raw, 'http://test');
  const p = url.pathname;
  if (p.endsWith('/me/review-queue')) return { status: 200, body: { items: [] } };
  if (p.endsWith('/me/context')) return { status: 200, body: ME_CONTEXT };
  if (p.endsWith('/auth/identity')) {
    return { status: 200, body: { state: 'linked', identity_id: 7 } };
  }
  if (p.endsWith('/findings/stats')) {
    return { status: 200, body: { total: 0, false_positive_rate: null } };
  }
  if (p.endsWith('/scanners')) return { status: 200, body: { items: [] } };
  if (/\/findings\/\d+\/history$/.test(p)) return { status: 200, body: { items: [] } };
  const one = /\/findings\/(\d+)$/.exec(p);
  if (one) {
    const reply = byId[Number(one[1])];
    if (reply === undefined) return problem(404, 'Finding not found');
    return reply;
  }
  if (p.endsWith('/findings')) {
    const page = pages[url.searchParams.get('cursor') ?? ''];
    return { status: 200, body: page ?? { items: [], next_cursor: null } };
  }
  return { status: 200, body: {} };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pages = { '': { items: [finding(1, 'first'), finding(2, 'second')], next_cursor: null } };
  byId = {};
  fetchMock = vi.fn(async (input: unknown) => {
    const { status, body } = await respond(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no layout, so no scrollIntoView; the explorer scrolls the panel
  // into view when one opens.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => vi.unstubAllGlobals());

/** The rail's own stub, so the explorer sees the same viewport the shell does. */
function stubViewport(width: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
    return {
      matches: width <= max,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList;
  });
}

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
  const findingParam = () => new URLSearchParams(router.history.location.search).get('finding');
  return { router, findingParam };
}

const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('selection is URL state at every width (W17-22 baseline defect)', () => {
  it.each([390, 1440])('clicking a row at %dpx writes ?finding= into the URL', async (width) => {
    stubViewport(width);
    const { findingParam } = renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-open-2'));
    await waitFor(() => expect(findingParam()).toBe('2'));
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 2');
  });

  it.each([390, 1440])('clicking the ROW, not the title text, opens it at %dpx', async (width) => {
    // The baseline capture clicked a row at 1440px and the URL did not change.
    // The only control was the title text: a click on the rest of the row —
    // the severity, the file, the empty width of a wide table — did nothing.
    stubViewport(width);
    const { findingParam } = renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-file-2'));
    await waitFor(() => expect(findingParam()).toBe('2'));
  });
});

describe('open, close, back, forward and reload (W17-22)', () => {
  it('back closes what open pushed, forward reopens it, and Close is its own entry', async () => {
    stubViewport(1440);
    const { router, findingParam } = renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-open-1'));
    await waitFor(() => expect(findingParam()).toBe('1'));
    await screen.findByTestId('finding-detail');

    router.history.back();
    await waitFor(() => expect(findingParam()).toBeNull());
    expect(screen.queryByTestId('finding-detail')).toBeNull();

    router.history.forward();
    await waitFor(() => expect(findingParam()).toBe('1'));
    await screen.findByTestId('finding-detail');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(findingParam()).toBeNull());
    expect(screen.queryByTestId('finding-detail')).toBeNull();
    router.history.back();
    await waitFor(() => expect(findingParam()).toBe('1'));
    await screen.findByTestId('finding-detail');
  });

  it('switching rows REPLACES, so Back leaves the screen rather than replaying the queue', async () => {
    stubViewport(1440);
    const { router, findingParam } = renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-open-1'));
    await waitFor(() => expect(findingParam()).toBe('1'));
    await user.click(screen.getByTestId('finding-open-2'));
    await waitFor(() => expect(findingParam()).toBe('2'));
    router.history.back();
    await waitFor(() => expect(findingParam()).toBeNull());
  });

  it('a reload (the URL alone) restores the open finding', async () => {
    stubViewport(1440);
    renderAt('/findings?finding=2');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 2');
  });
});

describe('overlay mode (W17-22)', () => {
  it('Escape closes the overlay and returns focus to the row that opened it', async () => {
    stubViewport(390);
    const { findingParam } = renderAt();
    const user = userEvent.setup();
    const opener = await screen.findByTestId('finding-open-2');
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: /second/ });
    // Focus moved INTO the overlay, or a keyboard user is still on a list the
    // overlay covers.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(findingParam()).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('finding-open-2'));
  });

  it('is inline, not a dialog, at 1440px', async () => {
    stubViewport(1440);
    renderAt('/findings?finding=2');
    await screen.findByTestId('finding-detail');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('paging and off-page links (W17-22)', () => {
  beforeEach(() => {
    pages = {
      '': { items: [finding(1, 'first'), finding(2, 'second')], next_cursor: 'c2' },
      c2: { items: [finding(3, 'third'), finding(4, 'fourth')], next_cursor: null },
    };
    byId = { 2: { status: 200, body: finding(2, 'second') } };
  });

  it('turning the page keeps the selection and fetches it by id when it is off the page', async () => {
    stubViewport(1440);
    const { findingParam } = renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('finding-open-2'));
    await waitFor(() => expect(findingParam()).toBe('2'));

    await user.click(screen.getByTestId('findings-next-page'));
    await screen.findByTestId('finding-open-3');
    expect(screen.queryByTestId('finding-open-2')).toBeNull();
    expect(findingParam()).toBe('2');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 2');
    expect(fetchedUrls().some((u) => /\/findings\/2$/.test(u))).toBe(true);

    await user.click(screen.getByTestId('findings-prev-page'));
    await screen.findByTestId('finding-open-1');
    expect(findingParam()).toBe('2');
    expect(screen.getByTestId('finding-detail')).toHaveTextContent('evidence for 2');
  });

  it('a pasted URL for a finding on no loaded page fetches that exact finding', async () => {
    stubViewport(1440);
    byId[99] = { status: 200, body: finding(99, 'ninety-nine') };
    renderAt('/findings?finding=99');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 99');
    expect(fetchedUrls().some((u) => /\/findings\/99$/.test(u))).toBe(true);
  });
});

describe('a finding this workspace cannot see (W17-22)', () => {
  it('a 404 never shows the previous selection, not even while the answer is in flight', async () => {
    stubViewport(1440);
    byId[99] = { status: 200, body: finding(99, 'ninety-nine') };
    const gone = deferred<Reply>();
    byId[100] = gone.promise;
    const { router, findingParam } = renderAt('/findings?finding=99');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 99');

    // Another workspace's id, pasted over this one. The API answers 404 (never
    // 403, so a link cannot probe for ids) — but until it answers, the panel
    // must not keep showing #99 under a URL that says #100.
    router.history.push('/findings?finding=100');
    await waitFor(() => expect(findingParam()).toBe('100'));
    expect(screen.queryByTestId('finding-detail')).toBeNull();
    expect(screen.queryByText(/evidence for 99/)).toBeNull();

    gone.resolve(problem(404, 'Finding not found'));
    await screen.findByTestId('finding-not-in-view');
    expect(screen.queryByTestId('finding-detail')).toBeNull();
    expect(screen.queryByText(/evidence for 99/)).toBeNull();
  });

  it('a 403 is an empty detail with its own sentence, not the previous finding', async () => {
    stubViewport(1440);
    byId[100] = problem(403, 'Not permitted');
    const { router } = renderAt('/findings?finding=1');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent('evidence for 1');
    router.history.push('/findings?finding=100');
    await screen.findByTestId('finding-forbidden');
    expect(screen.queryByTestId('finding-detail')).toBeNull();
    expect(screen.queryByText(/evidence for 1\b/)).toBeNull();
  });
});
