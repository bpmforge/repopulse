import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRouteWithContext } from '@tanstack/react-router';
import { createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from './__root.js';
import { createQueryClient } from '../api/queryClient.js';

// End-to-end shell behavior with a memory-history router (no browser needed).
// Verifies FR-WEB-2 (paste-a-URL restores the identical screen state) and the
// shell chrome (rail, filters, breadcrumb, theme toggle) from W4-02 acceptance.

function renderAt(initialUrl: string) {
  const queryClient = createQueryClient();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="home">home</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

// Silence "root route type not registered" is irrelevant here — we build the
// tree explicitly. This assertion keeps the import used.
void createRootRouteWithContext;

describe('app shell (__root) — W4-02', () => {
  it('renders the rail, topbar filters, breadcrumb, and main outlet', async () => {
    renderAt('/');
    expect(await screen.findByTestId('rail')).toBeInTheDocument();
    expect(screen.getByTestId('topbar')).toBeInTheDocument();
    expect(screen.getByTestId('filter-window')).toBeInTheDocument();
    expect(screen.getByTestId('breadcrumb')).toBeInTheDocument();
    expect(screen.getByTestId('home')).toBeInTheDocument();
    // Org Overview rail item is active on '/'.
    expect(screen.getByTestId('rail-org-overview')).toHaveAttribute('aria-current', 'page');
  });

  it('restores filter state from the URL (FR-WEB-2): ?window=90d&person=octocat', async () => {
    renderAt('/?window=90d&person=octocat');
    const windowSelect = (await screen.findByTestId('filter-window')) as HTMLSelectElement;
    const personInput = screen.getByTestId('filter-person') as HTMLInputElement;
    expect(windowSelect.value).toBe('90d');
    expect(personInput.value).toBe('octocat');
  });

  it('changing a filter serializes to the URL; nav links omit default filters', async () => {
    const user = userEvent.setup();
    const router = renderAt('/?window=90d');
    const windowSelect = (await screen.findByTestId('filter-window')) as HTMLSelectElement;

    await user.selectOptions(windowSelect, '7d');
    await waitFor(() => expect(router.state.location.searchStr).toContain('window=7d'));
    // Generated nav links carry the active non-default filter (drill-down keeps it).
    expect(screen.getByTestId('rail-repos').getAttribute('href')).toContain('window=7d');

    // Back to the default window (30d): the parsed state shows 30d, but the
    // default is OMITTED from generated links to keep them clean (DASHBOARD §1).
    await user.selectOptions(windowSelect, '30d');
    await waitFor(() => expect(windowSelect.value).toBe('30d'));
    expect(screen.getByTestId('rail-repos').getAttribute('href')).not.toContain('window');
  });

  it('theme toggle flips <html data-theme>', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByTestId('rail');
    const before = document.documentElement.getAttribute('data-theme');
    await user.click(screen.getAllByTestId('theme-toggle')[0]!);
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).not.toBe(before),
    );
  });
});
