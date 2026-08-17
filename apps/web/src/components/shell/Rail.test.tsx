import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RouterProvider, createRootRoute, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Rail } from './Rail.js';

// Rail badge semantics (W4-21, UX_SPEC §3.1 / R-A4).
//
// The distinction being pinned: ABSENT and ZERO must render identically —
// nothing. Findings do not exist until W6, so the Findings badge has no data
// source, and a badge frozen at 0 is indistinguishable from a working one. The
// review-queue badge is real, so a genuine count must render.

function renderRail(badges: Record<string, number>) {
  const rootRoute = createRootRoute({ component: () => <Rail badges={badges} /> });
  const router = createRouter({ routeTree: rootRoute });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function railItem(label: string): Promise<HTMLElement> {
  return await screen.findByTestId(`rail-${label}`);
}

describe('rail badges', () => {
  it('renders a real count', async () => {
    renderRail({ '/pull-requests': 4 });
    expect((await railItem('pull-requests')).textContent).toContain('4');
  });

  it('renders NOTHING for a zero count, not a zero', async () => {
    // The whole point. A "0" badge on Findings would look like a working badge
    // reporting no new findings, when in fact nothing feeds it yet.
    renderRail({ '/findings': 0 });
    const findings = await railItem('findings');
    expect(findings.textContent).not.toMatch(/\d/);
  });

  it('an absent badge and a zero badge are indistinguishable in the DOM', async () => {
    const { unmount } = renderRail({ '/findings': 0 });
    const withZero = (await railItem('findings')).textContent;
    unmount();

    renderRail({});
    const withNothing = (await railItem('findings')).textContent;
    expect(withZero).toBe(withNothing);
  });
});
