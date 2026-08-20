import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../../__root.js';
import { Route as repoRoute } from './route.js';
import { createQueryClient } from '../../../api/queryClient.js';

// A repository id that does not resolve is a routine URL: pasted links and
// bookmarks outlive re-seeds. The layout used to answer all of them with a bare
// "Not Found" and no navigation at all, so these tests pin both halves of the
// fix — a way onward always exists, and a 404 does not read like an outage.

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

/** What the API answers for the repo detail query; everything else succeeds. */
let repoResponse: { status: number; body: unknown };

beforeEach(() => {
  repoResponse = { status: 200, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const { status, body } = url.includes('/repos/')
        ? repoResponse
        : url.includes('/me/review-queue')
          ? { status: 200, body: { items: [] } }
          : url.includes('/me/context')
            ? { status: 200, body: ME_CONTEXT }
            : { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/**
 * The real layout route under the real shell, with a stub child in place of the
 * Pulse tab: the tab's own widgets would fire a dozen more queries and none of
 * them are what this file is about.
 */
function renderRepo(initialUrl: string) {
  const queryClient = createQueryClient();
  // A file route is exported with neither path nor parent — routeTree.gen.ts
  // `update()`s both in. Without repeating that here the route registers as a
  // second root and the router refuses the tree.
  const layoutRoute = repoRoute.update({
    id: '/repos/$repoId',
    path: '/repos/$repoId',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof repoRoute;
  const pulseRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/',
    component: () => <div data-testid="pulse-tab" />,
  });
  const reposIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/',
    component: () => <div data-testid="repos-list" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      layoutRoute.addChildren([pulseRoute] as never) as never,
      reposIndexRoute as never,
    ]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router };
}

const problem = (status: number, title: string) => ({
  status,
  body: { type: 'about:blank', title, status, request_id: 'req-42' },
});

describe('repo detail layout — unresolvable repository id', () => {
  it('a 404 still offers a route onward instead of a dead end', async () => {
    repoResponse = problem(404, 'Not Found');
    renderRepo('/repos/999');

    const frame = await screen.findByTestId('repo-error');
    expect(frame).toBeInTheDocument();
    // The actual defect: the only navigation left was the browser back button.
    const onward = screen.getByTestId('repo-error-to-list');
    expect(onward).toHaveAttribute('href', expect.stringContaining('/repos'));
  });

  it('a 404 says which situation this is, not "Not Found"', async () => {
    repoResponse = problem(404, 'Not Found');
    renderRepo('/repos/999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cannot see a repository with id 999/i);
    expect(alert).toHaveTextContent(/another workspace/i);
    // We do not know that it was deleted, and we have no name to quote back.
    expect(alert.textContent ?? '').not.toMatch(/delet|remov/i);
    // Nothing to retry: the answer would be the same 404 every time.
    expect(screen.queryByTestId('widget-retry')).not.toBeInTheDocument();
    // Tabs are omitted here on purpose — every one of them would 404 too.
    expect(screen.queryByTestId('repo-tabs')).not.toBeInTheDocument();
  });

  it('a generic failure reads differently: it keeps the tabs and a retry', async () => {
    repoResponse = problem(502, 'Bad Gateway');
    renderRepo('/repos/999');

    // Generous timeout: a 5xx is retried with backoff (queryClient.ts), so the
    // error state is several seconds away — unlike the 404, which is final.
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert).toHaveTextContent(/could not load repository 999/i);
    expect(alert).toHaveTextContent(/Bad Gateway/);
    // An outage says nothing about whether the repository exists, so it must
    // not borrow the 404 copy.
    expect(alert.textContent ?? '').not.toMatch(/another workspace/i);
    expect(screen.getByText(/request req-42/i)).toBeInTheDocument();
    expect(screen.getByTestId('widget-retry')).toBeInTheDocument();
    // Two ways onward here: the sibling tabs may well load, plus the list.
    expect(screen.getByTestId('repo-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('repo-error-to-list')).toBeInTheDocument();
  }, 15000);

  it('renders the normal layout with tabs when the repository resolves', async () => {
    repoResponse = {
      status: 200,
      body: {
        id: 7,
        org: 'acme',
        name: 'web',
        health: { grade: 'B', score: 72, basis: [] },
      },
    };
    renderRepo('/repos/7');

    await waitFor(() => expect(screen.getByTestId('repo-name')).toHaveTextContent('acme/web'));
    expect(screen.getByTestId('repo-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-error')).not.toBeInTheDocument();
  });
});
