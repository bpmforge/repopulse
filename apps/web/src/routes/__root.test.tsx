import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRouteWithContext } from '@tanstack/react-router';
import { createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from './__root.js';
import { createQueryClient } from '../api/queryClient.js';
import { queryKeyFor, useApiQuery } from '../api/useApiQuery.js';

// End-to-end shell behavior with a memory-history router (no browser needed).
// Verifies FR-WEB-2 (paste-a-URL restores the identical screen state) and the
// shell chrome (rail, filters, breadcrumb, theme toggle) from W4-02 acceptance.

// The shell now gates on the session (W-FIX), so every test has to say who the
// visitor is. The stub dispatches on URL rather than answering everything with
// one body: /me/review-queue must return `{items}` or the rail badge throws.
const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

let respond: (url: string) => { status: number; body: unknown };

function signedIn(url: string) {
  if (url.includes('/me/review-queue')) return { status: 200, body: { items: [] } };
  if (url.includes('/me/context')) return { status: 200, body: ME_CONTEXT };
  return { status: 200, body: {} };
}

/** What the API actually answers with no session: RFC 7807, 401. */
function signedOut() {
  return {
    status: 401,
    body: { type: 'about:blank', title: 'No active session', status: 401 },
  };
}

beforeEach(() => {
  respond = signedIn;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const { status, body } = respond(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(initialUrl: string, home: ReactNode = <div data-testid="home">home</div>) {
  const queryClient = createQueryClient();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{home}</>,
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
  return { router, queryClient };
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
    const { router } = renderAt('/?window=90d');
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

// W-FIX: signed out, the app used to render the full authenticated shell with a
// red "No active session" error and a Retry button on every card. The session is
// now detected once, centrally, and decides which screen exists at all.
describe('unauthenticated visitor (W-FIX)', () => {
  it('meets the sign-in screen instead of the shell full of errors', async () => {
    respond = signedOut;
    renderAt('/');

    expect(await screen.findByTestId('signin')).toBeInTheDocument();
    expect(screen.getByTestId('signin-github')).toHaveAttribute('href', '/auth/login');
    // None of the authenticated chrome, and — the actual defect — no failure
    // state anywhere describing something that is not a failure.
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('widget-retry')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('No active session');
  });

  it('says "never signed in" rather than "expired" on a cold visit', async () => {
    respond = signedOut;
    renderAt('/');
    expect(await screen.findByTestId('signin')).toHaveTextContent(/Sign in to see/i);
  });

  it('a 401 on ANY widget query flips the whole shell to sign-in, once', async () => {
    function HomeWidget() {
      const { isError } = useApiQuery<Record<string, never>>({ endpoint: '/org/summary' });
      return <div data-testid="home">{isError ? 'failed' : 'ok'}</div>;
    }
    const { queryClient } = renderAt('/', <HomeWidget />);
    expect(await screen.findByTestId('rail')).toBeInTheDocument();

    // The session expires mid-use: only the widget's own query is re-run, so
    // this proves the central watcher — not the shell polling /me/context.
    respond = signedOut;
    await queryClient.invalidateQueries({ queryKey: queryKeyFor({ endpoint: '/org/summary' }) });

    const signin = await screen.findByTestId('signin');
    expect(signin).toHaveTextContent(/session ended/i);
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
  });

  it('keeps the shell when the API fails with something that is NOT a 401', async () => {
    // An outage is not a logged-out user. Turning a 502 into a sign-in wall
    // would have the product lie about why the screen is empty; the widgets
    // report it honestly instead, with a request id and a retry.
    respond = () => ({ status: 502, body: { title: 'Bad gateway', status: 502 } });
    renderAt('/');
    expect(await screen.findByTestId('rail', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  }, 15000);
});
