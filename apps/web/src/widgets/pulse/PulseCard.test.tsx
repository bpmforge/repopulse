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
import { PulseCard } from './PulseCard.js';

// W20-20 (UX_TODO DSH-51 / DSH-74): the pulse names its period and what it
// compares with, every metric bullet opens its evidence, and the provenance
// line is plain words.

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            bullets: [
              { id: 'M5', text: 'Review coverage improved.', direction: 'better' },
              { id: 'findings', text: '3 findings are open.', direction: 'flat' },
              { id: 'filler-4', text: 'No further movement.', direction: 'flat' },
            ],
            provenance: 'narrated',
            window: '90d',
            compared_with: 'the value 90 days earlier',
          }),
          { status: 200 },
        ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderCard() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <PulseCard
        widget={
          {
            id: 'p',
            type: 'weekly-pulse',
            layout: { x: 0, y: 0, w: 4, h: 2 },
            options: { window: '90d' },
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

describe('Pulse card', () => {
  it('names the window and the comparison', async () => {
    renderCard();
    expect(await screen.findByText('Pulse · last 90d')).toBeInTheDocument();
    expect(await screen.findByTestId('pulse-period')).toHaveTextContent(
      'Over the last 90d; changes compare with the value 90 days earlier.',
    );
  });

  it('links metric and findings bullets to their evidence, not fillers', async () => {
    renderCard();
    expect((await screen.findByTestId('pulse-link-M5')).getAttribute('href')).toContain(
      'unreviewed=true',
    );
    expect(screen.getByTestId('pulse-link-findings').getAttribute('href')).toContain('/findings');
    expect(screen.queryByTestId('pulse-link-filler-4')).toBeNull();
  });

  it('says a local model reworded it in plain words', async () => {
    renderCard();
    expect(await screen.findByTestId('pulse-provenance')).toHaveTextContent(
      'Reworded by your local AI model',
    );
  });
});
