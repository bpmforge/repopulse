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
import { RepoPerformance } from './RepoPerformance.js';
import { latestValue, UNCOMPUTED_DORA } from './contracts.js';

// The Performance tab must never let "not measured" read as a number, and must
// say which DORA measures it is NOT showing (W17-19, the W17-18 lesson).

const CI = {
  window: '30d',
  computed_at: '2026-09-01T00:00:00Z',
  pass_rate: 0.925,
  pr_pass_rate: 0.8,
  default_branch_runs: 40,
  pr_runs: 120,
  duration: { medianMs: 300_000, p90Ms: 600_000 },
  flakiest: [],
  flakiness_workflows: 0,
  components_available: true,
};

const series = (values: (number | null)[], basis: string | null = null) => ({
  points: values.map((value, i) => ({ computed_at: `2026-08-0${i + 1}T00:00:00Z`, value })),
  basis_label: basis,
});

let metricSeries: Record<string, unknown>;

beforeEach(() => {
  metricSeries = {
    M11: series([2, 3], 'releases'),
    M12: series([null, null]),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const key = /metric_key=(M\d+)/.exec(url)?.[1];
      const body = url.includes('/repos/7/ci') ? CI : key ? (metricSeries[key] ?? series([])) : {};
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

function renderPerformance() {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/performance',
    component: () => <RepoPerformance repoId="7" window="30d" search={{ window: '30d' }} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/repos/7/performance?window=30d'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('latestValue', () => {
  it('returns the newest measured point, skipping trailing nulls', () => {
    expect(latestValue(series([1, 4, null]))).toBe(4);
  });
  it('is null, not 0, when nothing was ever measured', () => {
    expect(latestValue(series([null, null]))).toBeNull();
    expect(latestValue(undefined)).toBeNull();
  });
});

describe('RepoPerformance (W17-19)', () => {
  it('shows the latest release cadence with its basis, and a dash for the unmeasured', async () => {
    renderPerformance();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByTestId('basis-M11')).toHaveTextContent('releases');
    // Deployment frequency has no measured point: an em dash, never "0".
    const tiles = screen.getAllByTestId('kpi-tile');
    const deploy = tiles.find((t) => t.textContent?.includes('Deployment frequency'));
    expect(deploy).toHaveTextContent('—');
    expect(deploy?.textContent).not.toMatch(/\b0\b/);
  });

  it('repeats CI duration as a tile and links to the CI tab rather than re-charting it', async () => {
    renderPerformance();
    expect(await screen.findByText('5.0m')).toBeInTheDocument();
    // W20-12 (DSH-26): the pass rate is the Activity CI card's figure; it is
    // not repeated as a second tile in the same tab.
    expect(screen.queryByText('93')).not.toBeInTheDocument();
    expect(screen.getByTestId('performance-to-ci')).toHaveAttribute(
      'href',
      expect.stringMatching(/\/repos\/7\/ci\?.*window=30d/),
    );
    expect(screen.getByTestId('performance-to-pulse')).toHaveAttribute(
      'href',
      expect.stringMatching(/\/repos\/7\?.*window=30d/),
    );
  });

  it('names every DORA measure it does not compute', async () => {
    renderPerformance();
    const panel = await screen.findByTestId('uncomputed-dora');
    for (const name of UNCOMPUTED_DORA) expect(panel).toHaveTextContent(name);
  });
});
