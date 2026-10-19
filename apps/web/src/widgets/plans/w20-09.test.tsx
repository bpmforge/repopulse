import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { planForScope } from './PlanTile.js';
import { RepoPulse } from '../repo/RepoPulse.js';
import { KpiRow } from '../org/KpiRow.js';
import { reposParam, withRepos } from '../scopeRepos.js';
import type { Plan } from './contracts.js';

// W20-09. The plan tile shows the current plan for the view's own scope
// (DSH-02/58), the repo Pulse tab leads with what to do next (DSH-12), and the
// KPI row asks for the view's repositories (DSH-02).

const plan = (over: Partial<Plan>): Plan => ({
  id: 1,
  window: '30d',
  repo_ids: [],
  catalog_version: 'v6',
  status: 'active',
  created_at: '2026-10-01T00:00:00.000Z',
  items: [],
  ...over,
});

describe('planForScope', () => {
  const plans = [
    plan({ id: 9, repo_ids: [3], status: 'archived' }),
    plan({ id: 8, repo_ids: [3, 4] }),
    plan({ id: 7, repo_ids: [3] }),
    plan({ id: 6 }),
  ];

  it('never shows a superseded plan', () => {
    expect(planForScope(plans, [3])?.id).toBe(7);
  });

  it('a repo-scoped view gets the plan for exactly its repositories, or none', () => {
    expect(planForScope(plans, [4, 3])?.id).toBe(8);
    expect(planForScope(plans, [5])).toBeUndefined();
  });

  it('the whole workspace gets the newest active plan', () => {
    expect(planForScope(plans, [])?.id).toBe(8);
  });
});

describe('scope params', () => {
  it('drops all and absent, keeps a csv', () => {
    expect(reposParam(undefined)).toBeUndefined();
    expect(reposParam({ repos: 'all' })).toBeUndefined();
    expect(reposParam({ repos: '3,4' })).toBe('3,4');
    expect(withRepos({ window: '30d' }, undefined)).toEqual({ window: '30d' });
    expect(withRepos({ window: '30d' }, '3')).toEqual({ window: '30d', repos: '3' });
  });
});

let urls: string[] = [];
beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('/org/summary')
        ? { window: '30d', tiles: [{ metric_key: 'M5', value: 0.8, delta: 0.1, previous: 0.7 }] }
        : url.includes('/risk/top')
          ? { items: [], counts: { open: 0, act: 0, schedule: 0, track: 0, unpriced: 0 } }
          : { points: [] };
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

function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);
}

describe('KpiRow under a repository scope (DSH-02)', () => {
  it('asks /org/summary for the view’s repositories and draws no workspace sparkline', async () => {
    wrap(<KpiRow window="30d" repos="3,4" />);
    await screen.findByTestId('kpi-row');
    await waitFor(() => expect(urls.some((u) => u.includes('/org/summary'))).toBe(true));
    const summary = urls.find((u) => u.includes('/org/summary'))!;
    expect(summary).toContain('repos=3%2C4');
    // A set has no stored series; asking for the org one would mislabel it.
    expect(urls.some((u) => u.includes('/metrics/series'))).toBe(false);
  });

  it('one repository keeps its own sparkline series', async () => {
    wrap(<KpiRow window="30d" repos="3" />);
    await screen.findByTestId('kpi-row');
    await waitFor(() => expect(urls.some((u) => u.includes('/metrics/series'))).toBe(true));
    expect(
      urls.filter((u) => u.includes('/metrics/series')).every((u) => u.includes('repo_id=3')),
    ).toBe(true);
  });
});

describe('repo Pulse leads with what to do next (DSH-12)', () => {
  it('shows current values, this repository’s top risks and the plan before the trends', async () => {
    wrap(<RepoPulse repoId="3" window="30d" />);
    const pulse = await screen.findByTestId('repo-pulse');
    expect(screen.getByText('Current values')).toBeInTheDocument();
    expect(screen.getByTestId('repo-next-steps')).toBeInTheDocument();
    expect(screen.getByTestId('plan-for-repo-link')).toHaveAttribute('href', '/plans?repos=3');
    expect(screen.getByTestId('generate-plan')).toHaveTextContent(
      'Generate 30d plan for 1 repository',
    );
    await waitFor(() => expect(urls.some((u) => u.includes('/risk/top?repo_id=3'))).toBe(true));
    // The actions sit ABOVE the trend charts.
    const order = [...pulse.querySelectorAll('[data-testid]')].map((n) =>
      n.getAttribute('data-testid'),
    );
    expect(order.indexOf('repo-next-steps')).toBeLessThan(order.indexOf('repo-pulse-trends'));
  });
});
