import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { KpiRow } from './KpiRow.js';

// The org KPI row (W4-xx), untested until now — flagged by the agent that
// changed KpiTile's empty-delta handling and could not prove the org row still
// read correctly. A tile that renders "not measured" and one that renders a
// real number must stay distinguishable here too, not just in the primitive.

function renderWith(summary: unknown, window = '30d', repos?: string) {
  const calls: string[] = [];
  // The tiles link to their evidence (W20-20), so they need a router.
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // The row asks for the summary and then a series per tile; an empty
      // series must not break the tiles.
      const body = url.includes('/metrics/') ? { points: [{ value: 1 }, { value: 2 }] } : summary;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <KpiRow window={window} repos={repos} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('org KPI row', () => {
  it('renders a measured value as a number', async () => {
    // The real /org/summary shape — tiles[], metric_key, value, delta. My
    // first version of this test invented { kpis, key, delta_pct } and failed
    // for that reason, not because the row was broken.
    renderWith({ window: '30d', tiles: [{ metric_key: 'M5', value: 0.5, delta: 12 }] });
    expect(await screen.findAllByTestId('kpi-tile')).not.toHaveLength(0);
    expect(screen.getByText(/50/)).toBeInTheDocument();
  });

  it('says a metric is NOT MEASURED rather than showing it as zero', async () => {
    // The distinction the whole product rests on: an absent metric and a
    // metric that measured zero must not read the same.
    renderWith({ window: '30d', tiles: [{ metric_key: 'M5', value: null, delta: null }] });
    const tiles = await screen.findAllByTestId('kpi-tile');
    expect(tiles.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/not measured|no prior window|not compared/i).length,
    ).toBeGreaterThan(0);
  });
});

describe('KPI deltas and samples (W20-12)', () => {
  it('shows a percentage metric change in points, with better/worse in words (DSH-17)', async () => {
    renderWith({
      window: '30d',
      tiles: [{ metric_key: 'M5', value: 0.45, delta: 0.05, previous: 0.4 }],
    });
    const tile = (await screen.findAllByTestId('kpi-tile')).find((t) =>
      t.textContent?.includes('Review coverage'),
    )!;
    expect(tile.textContent).toContain('5.0 pts');
    expect(tile.textContent).toContain('better');
    expect(tile.textContent).not.toMatch(/12\.5%/);
  });

  it('shows the change from a zero baseline instead of "no prior window" (DSH-83)', async () => {
    renderWith({
      window: '30d',
      tiles: [{ metric_key: 'M10', value: 5, delta: 5, previous: 0 }],
    });
    const tile = (await screen.findAllByTestId('kpi-tile')).find((t) =>
      t.textContent?.includes('Issue throughput'),
    )!;
    expect(tile.textContent).toContain('5 from 0');
    expect(tile.textContent).not.toMatch(/no prior window/);
  });

  it('says how many items a ratio rests on, and flags a small sample (DSH-81)', async () => {
    renderWith({
      window: '30d',
      tiles: [
        {
          metric_key: 'M5',
          value: 1,
          delta: null,
          previous: null,
          sample: { numerator: 1, denominator: 1 },
        },
      ],
    });
    expect(await screen.findByTestId('kpi-sample-M5')).toHaveTextContent('1 of 1 · small sample');
  });
});

describe('custom date range (W20-20, UX_TODO DSH-56)', () => {
  it('asks for the exact range, says what it was computed for, and draws no preset line', async () => {
    const calls = renderWith(
      {
        window: '2026-09-01..2026-09-14',
        range: { from: '2026-09-01', to: '2026-09-14', days: 14 },
        tiles: [{ metric_key: 'M5', value: 0.5, delta: 0.1, previous: 0.4 }],
      },
      '2026-09-01..2026-09-14',
    );
    expect(await screen.findByTestId('kpi-range-note')).toHaveTextContent(
      'Computed for 2026-09-01 to 2026-09-14 (14 days); changes compare with the 14 days before.',
    );
    expect(calls.some((u) => u.includes('/org/summary?window=2026-09-01..2026-09-14'))).toBe(true);
    expect(calls.some((u) => u.includes('/metrics/series'))).toBe(false);
  });
});

describe('sparkline label (W20-20, UX_TODO DSH-55)', () => {
  it('says the current value and the change, not only the metric name', async () => {
    renderWith({
      window: '30d',
      tiles: [{ metric_key: 'M5', value: 0.5, delta: 0.1, previous: 0.4 }],
    });
    expect(
      await screen.findByLabelText(/Review coverage.*now 50 %, up 10\.0 pts on the window before/),
    ).toBeInTheDocument();
  });
});

describe('KPI evidence links (W20-20, UX_TODO DSH-18)', () => {
  it('review coverage opens the unreviewed merged PRs, in the same scope', async () => {
    renderWith(
      { window: '30d', tiles: [{ metric_key: 'M5', value: 0.5, delta: null }] },
      '30d',
      '4,5',
    );
    const link = await screen.findByTestId('kpi-evidence-M5');
    expect(link.getAttribute('href')).toContain('/pull-requests');
    expect(link.getAttribute('href')).toContain('unreviewed=true');
    expect(link.getAttribute('href')).toContain('repos=');
  });

  it('one repository opens its own CI tab; issue throughput has no link', async () => {
    renderWith(
      { window: '30d', tiles: [{ metric_key: 'M9', value: 0.9, delta: null }] },
      '30d',
      '7',
    );
    expect((await screen.findByTestId('kpi-evidence-M9')).getAttribute('href')).toBe('/repos/7/ci');
    expect(screen.queryByTestId('kpi-evidence-M10')).toBeNull();
  });
});
