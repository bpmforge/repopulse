import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createQueryClient } from '../../../api/queryClient.js';
import { Route as findingsRoute } from './findings.js';
import type { Finding } from '../../../widgets/findings/contracts.js';

// Repo → Findings pages and filters by status (W20-03, UX_TODO FND-14). It
// showed the first fifty, every status mixed together, with no sign more
// existed.

function finding(id: number, status = 'open'): Finding {
  return {
    id,
    repo: { id: 7, org: 'acme', name: 'web' },
    dimension: 'security',
    severity: 4,
    confidence: 4,
    title: `finding ${id}`,
    file: 'src/a.ts',
    line_range: [1, 2],
    evidence: 'e',
    recommendation: 'r',
    status,
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
  } as unknown as Finding;
}

let requests: URL[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = new URL(String(input), 'http://test');
      requests.push(url);
      const cursor = url.searchParams.get('cursor');
      const body = url.pathname.endsWith('/findings')
        ? cursor === 'c2'
          ? { items: [finding(3)], next_cursor: null, total: 3 }
          : { items: [finding(1), finding(2)], next_cursor: 'c2', total: 3 }
        : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(url: string) {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/findings',
    validateSearch: findingsRoute.options.validateSearch as never,
    component: findingsRoute.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route as never]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return router;
}

const lastList = () => requests.filter((u) => u.pathname.endsWith('/findings')).at(-1)!;

describe('Repo → Findings (FND-14)', () => {
  it('asks for open findings by default and says how many there are', async () => {
    renderAt('/repos/7/findings');
    await screen.findByTestId('finding-1');
    expect(lastList().searchParams.get('status')).toBe('open');
    expect(lastList().searchParams.get('repo_id')).toBe('7');
    expect(screen.getByText('Findings (3 open)')).toBeInTheDocument();
  });

  it('pages with next_cursor, forward and back', async () => {
    renderAt('/repos/7/findings');
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.click(screen.getByTestId('repo-findings-next-page'));
    await screen.findByTestId('finding-3');
    expect(lastList().searchParams.get('cursor')).toBe('c2');
    await user.click(screen.getByTestId('repo-findings-prev-page'));
    await screen.findByTestId('finding-1');
  });

  it('the status filter is in the URL, and Any asks for every status', async () => {
    const router = renderAt('/repos/7/findings');
    const user = userEvent.setup();
    await screen.findByTestId('finding-1');
    await user.selectOptions(screen.getByTestId('repo-filter-status'), '');
    await waitFor(() => expect(lastList().searchParams.has('status')).toBe(false));
    expect(router.history.location.search).toMatch(/status=any/);
    expect(screen.getByTestId('repo-findings-in-reviews').getAttribute('href')).toMatch(
      /status=any/,
    );
  });
});
