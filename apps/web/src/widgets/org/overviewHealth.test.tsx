import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { healthBand as sharedBand } from '@repopulse/shared/health-band';
import { createQueryClient } from '../../api/queryClient.js';
import { healthBand } from '../../components/index.js';
import { HEALTH_TILE_CAP, HealthTileGrid } from './HealthTileGrid.js';
import { AttentionFeed } from './AttentionFeed.js';
import { HotspotLeaderboard } from './HotspotLeaderboard.js';
import { useUiStore } from '../../components/store/uiStore.js';

// W20-05 — the Overview's Repo health and Needs attention cards
// (UX_TODO X-05, DSH-08, DSH-09, DSH-10, DSH-02).

const tile = (id: number, score: number | null, org = 'acme') => ({
  id,
  org,
  name: `repo${id}`,
  health: {
    score,
    letter: null,
    measured: score !== null,
    basis: score === null ? 'not measured' : 'full',
    delta: null,
  },
});

let bodies: Record<string, unknown>;
const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  bodies = {};
  // The router restores scroll; jsdom has no scrollTo.
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      const key = Object.keys(bodies).find((k) => url.includes(k));
      return Promise.resolve(
        new Response(JSON.stringify(key ? bodies[key] : {}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderInRouter(node: React.ReactNode) {
  const rootRoute = createRootRoute();
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => node });
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

describe('Repo health card (W20-05)', () => {
  it('shows the worst dozen with a way to the rest, labelled org/name (X-05)', async () => {
    bodies['/org/health-tiles'] = {
      items: Array.from({ length: 30 }, (_, i) => tile(i + 1, 10 + i)),
    };
    renderInRouter(<HealthTileGrid window="30d" search={{}} />);
    const seeAll = await screen.findByTestId('health-see-all');
    expect(screen.getByTestId('health-tile-grid').querySelectorAll('li')).toHaveLength(
      HEALTH_TILE_CAP,
    );
    expect(seeAll.textContent).toBe('See all 30 in Repositories');
    expect(seeAll.getAttribute('href')).toContain('sort=health%3Aasc');
    expect(screen.getByTestId('health-tile-1').textContent).toContain('acme/repo1');
  });

  it('draws an unmeasured repository as "—", never a red 0 (DSH-08)', async () => {
    bodies['/org/health-tiles'] = { items: [tile(1, 60), tile(2, null)] };
    renderInRouter(<HealthTileGrid window="30d" search={{}} />);
    const unmeasured = await screen.findByTestId('health-tile-2');
    const badge = unmeasured.querySelector('[data-testid="health-badge"]')!;
    expect(badge.getAttribute('data-band')).toBe('none');
    expect(badge.textContent).toBe('—');
    expect(unmeasured.textContent).toContain('Not measured yet');
    expect(screen.queryByTestId('health-see-all')).toBeNull();
  });

  it("sends the view's repository scope to the API (DSH-02)", async () => {
    bodies['/org/health-tiles'] = { items: [tile(7, 60)] };
    renderInRouter(<HealthTileGrid window="90d" search={{ window: '90d', repos: '7,8' }} />);
    await screen.findByTestId('health-tile-7');
    expect(urls.find((u) => u.includes('/org/health-tiles'))).toContain('repos=7%2C8');
  });

  it('the hotspot leaderboard takes the same scope (DSH-02)', async () => {
    bodies['/hotspots'] = { items: [] };
    renderInRouter(<HotspotLeaderboard window="90d" search={{ window: '90d', repos: '7' }} />);
    await waitFor(() => expect(urls.find((u) => u.includes('/hotspots'))).toContain('repos=7'));
  });
});

describe('Needs attention card (W20-05)', () => {
  it('claims no "since your last visit" diff and marks nothing seen (DSH-09)', async () => {
    useUiStore.getState().markSeen('2026-10-01T00:00:00Z');
    bodies['/org/attention'] = { items: [] };
    renderInRouter(<AttentionFeed window="30d" search={{}} />);
    expect(
      await screen.findByText('Every measured repository is in the healthy band (75 or above).'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/since your last visit/)).toBeNull();
    expect(useUiStore.getState().lastSeenAt).toBe('2026-10-01T00:00:00Z');
    expect(urls.find((u) => u.includes('/org/attention'))).not.toContain('since=');
  });

  it('uses the health badge words for the band (DSH-10)', async () => {
    bodies['/org/attention'] = {
      items: [
        { repo_id: 1, org: 'acme', name: 'infra', kind: 'health_band', band: 'attend', score: 38 },
        { repo_id: 2, org: 'acme', name: 'web', kind: 'health_band', band: 'watch', score: 72 },
      ],
    };
    renderInRouter(<AttentionFeed window="30d" search={{}} />);
    expect((await screen.findByTestId('attention-1')).textContent).toContain('needs attention');
    expect(screen.getByTestId('attention-2').textContent).toContain('watch');
    expect(screen.getByTestId('attention-2').textContent).toContain('72');
  });

  it('the badge and the API band from one function (DSH-10)', () => {
    // 72 was "watch" on the grid and absent from Needs attention under the
    // letter cut-offs. One function now decides both.
    expect(healthBand).toBe(sharedBand);
    expect(healthBand(72)).toBe('watch');
    expect(healthBand(75)).toBe('good');
    expect(healthBand(49)).toBe('attend');
  });
});
