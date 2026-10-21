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
import { SecurityRollupTile } from './SecurityRollupTile.js';

// W20-20 (UX_TODO DSH-76 / DSH-77): the basis names the scanners that ran,
// "not scanned yet" replaces zeros, live checks are said to be off, and
// rules in trial are counted separately.

let body: unknown;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderTile() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <SecurityRollupTile />,
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

const base = {
  open_by_severity: { '4': 2 },
  open_total: 2,
  kev_count: 0,
  secrets_open: 0,
  verified_secrets: 0,
  worst_chain: null,
  live_checks: false,
};

describe('Security rollup tile', () => {
  it('says "not scanned yet" instead of zeros when no scan has finished', async () => {
    body = {
      ...base,
      open_by_severity: {},
      open_total: 0,
      scanned: false,
      scanners_run: [],
      basis: 'no security scan has finished',
    };
    renderTile();
    expect(await screen.findByTestId('rollup-not-scanned')).toBeInTheDocument();
    expect(screen.queryByTestId('sev-5')).toBeNull();
  });

  it('names the scanners that ran, live checks off, and rules in trial', async () => {
    body = {
      ...base,
      scanned: true,
      scanners_run: [
        { key: 'dependency', last_finished_at: '2026-10-20T02:00:00.000Z' },
        { key: 'secrets', last_finished_at: '2026-10-19T02:00:00.000Z' },
      ],
      basis: 'scanners: dependency, secrets',
      experimental_open: 3,
    };
    renderTile();
    expect(await screen.findByTestId('rollup-basis')).toHaveTextContent(
      'Basis: dependency (last run 2026-10-20), secrets (last run 2026-10-19)',
    );
    expect(screen.getByTestId('rollup-verified')).toHaveTextContent(
      'live credential checks are off',
    );
    expect(screen.getByTestId('rollup-trial')).toHaveTextContent('+3 from rules in trial');
  });
});
