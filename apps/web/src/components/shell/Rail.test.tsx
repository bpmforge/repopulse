import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// W16-05 (F21). At ~800px the expanded rail took 240px of a screen that had
// none to spare: content was pushed out of view, repository names truncated to
// "pay…", and the page scrolled sideways. The collapsed state already existed
// and was reachable only by clicking the toggle — not much use to someone whose
// window is already too narrow to read.
describe('narrow windows (W16-05, F21)', () => {
  function stubViewport(width: number) {
    vi.stubGlobal('innerWidth', width);
    vi.stubGlobal('matchMedia', (query: string) => {
      const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
      return {
        matches: width <= max,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as MediaQueryList;
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('collapses itself below the breakpoint', async () => {
    stubViewport(420);
    renderRail({});
    const rail = await screen.findByTestId('rail');
    expect(rail).toHaveAttribute('data-collapsed', 'true');
    // Labels gone, icons kept — that is what buys the width back.
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('stays expanded on a wide window', async () => {
    stubViewport(1440);
    renderRail({});
    const rail = await screen.findByTestId('rail');
    expect(rail).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  it('hides the toggle when the window is what forced the collapse', async () => {
    // The button could not change anything there, and a control that visibly
    // does nothing is worse than no control.
    stubViewport(420);
    renderRail({});
    expect(await screen.findByTestId('rail-collapse')).toHaveAttribute('hidden');
  });
});
