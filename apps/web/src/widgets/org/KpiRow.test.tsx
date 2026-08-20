import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { KpiRow } from './KpiRow.js';

// The org KPI row (W4-xx), untested until now — flagged by the agent that
// changed KpiTile's empty-delta handling and could not prove the org row still
// read correctly. A tile that renders "not measured" and one that renders a
// real number must stay distinguishable here too, not just in the primitive.

function renderWith(summary: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // The row asks for the summary and then a series per tile; an empty
      // series must not break the tiles.
      const body = url.includes('/metrics/') ? { points: [] } : summary;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KpiRow window="30d" />
    </QueryClientProvider>,
  );
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
    expect(screen.getAllByText(/not measured|no prior window|not compared/i).length).toBeGreaterThan(0);
  });
});
