import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createQueryClient } from '../../api/queryClient.js';
import { PlanTile } from './PlanTile.js';

// W20-20 (UX_TODO DSH-50): the Overview plan tile names its repositories, says
// when the plan was generated, and opens the Plans page on that plan's scope.

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = /\/plans(\?|$)/.test(url)
        ? {
            items: [
              {
                id: 5,
                window: '30d',
                repo_ids: [3],
                catalog_version: 'v6',
                status: 'active',
                created_at: '2026-10-02T08:00:00.000Z',
                items: [],
              },
            ],
          }
        : /\/repos(\?|$)/.test(url)
          ? { items: [{ id: 3, org: 'acme', name: 'api' }] }
          : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderTile() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <PlanTile
        widget={
          {
            id: 'plan',
            type: 'plan-progress',
            layout: { x: 0, y: 0, w: 3, h: 2 },
            options: {},
          } as never
        }
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('plan tile (DSH-50)', () => {
  it('names the repository and the generated date', async () => {
    renderTile();
    expect(await screen.findByText(/Scope: acme\/api/)).toHaveTextContent(
      'Scope: acme/api · generated 2026-10-02',
    );
  });

  it('opens the Plans page scoped to the plan, at the plan', async () => {
    renderTile();
    const link = await screen.findByTestId('plan-tile-link');
    expect(link.getAttribute('href')).toContain('/plans?repos=');
    expect(link.getAttribute('href')).toMatch(/#plan-5$/);
  });
});
