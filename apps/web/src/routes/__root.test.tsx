import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRouteWithContext } from '@tanstack/react-router';
import { createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  downFromHealthDetail,
  isServerSideFailure,
  topbarRepoOptions,
  Route as rootRoute,
  type RouterContext,
} from './__root.js';
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
  // W15-04: the shell asks why personalized views would be empty. 'linked' is
  // the quiet answer, so these tests see no forge banner.
  if (url.includes('/auth/identity')) {
    return { status: 200, body: { state: 'linked', identity_id: 7 } };
  }
  // The shell reads the provider list while signed in too, and caches it for
  // good — so the sign-in screen that opens over the app (X-02) uses this one.
  if (url.includes('/auth/providers')) {
    return { status: 200, body: { local: true, oidc: null, github: false } };
  }
  return { status: 200, body: {} };
}

/**
 * What the API actually answers with no session: RFC 7807, 401 on everything
 * behind the session — but NOT on the two /auth endpoints the sign-in screen
 * needs, which exist precisely for people who have no session (W15-04).
 */
function signedOut(url: string) {
  if (url.includes('/auth/providers')) {
    return { status: 200, body: { local: true, oidc: null, github: false } };
  }
  if (url.includes('/auth/local/session')) {
    return { status: 200, body: { pending_password_change: false } };
  }
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
  // A stand-in for the report viewer, so the /print/* gate can be exercised.
  const printRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/print/reports/$reportId',
    component: () => <div data-testid="print-viewer">report</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, printRoute]),
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
    // Overview rail item is active on '/'.
    expect(screen.getByTestId('rail-home')).toHaveAttribute('aria-current', 'page');
  });

  it('restores filter state from the URL (FR-WEB-2): ?window=90d', async () => {
    renderAt('/?window=90d&person=octocat');
    const windowSelect = (await screen.findByTestId('filter-window')) as HTMLSelectElement;
    expect(windowSelect.value).toBe('90d');
  });

  it('offers only the filters the screen APPLIES (W16-50)', async () => {
    // The org overview applies the window and nothing else: its nine widgets
    // read five org-rollup endpoints with no repo_id, and it is already scoped
    // to one person by nobody. A control that silently does nothing is worse
    // than a missing one — which is what all three used to be, everywhere.
    renderAt('/?window=90d&person=octocat');
    expect(await screen.findByTestId('filter-window')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-person')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-repos')).not.toBeInTheDocument();
  });

  it('shows a filter again on a screen that DOES apply it, with its value', async () => {
    // The value rides in the URL while the control is hidden, so hiding it on
    // one screen must not lose it for the next — the org PR list narrows by
    // author, and that is where the same `?person=` becomes a control again.
    renderAt('/pull-requests?person=octocat');
    const personInput = (await screen.findByTestId('filter-person')) as HTMLInputElement;
    expect(personInput.value).toBe('octocat');
    // …and the window, which that list does not apply, is not offered.
    expect(screen.queryByTestId('filter-window')).not.toBeInTheDocument();
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
    // W15-04: local sign-in is what every deployment has. The GitHub link is
    // absent here because this stub's deployment has no GitHub App, and a
    // button that leads to an unregistered /auth/login is the defect
    // /auth/providers exists to prevent.
    expect(await screen.findByTestId('signin-local')).toBeInTheDocument();
    expect(screen.queryByTestId('signin-github')).not.toBeInTheDocument();
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

  // W15-04: the two transitions the sign-in screen exists to make. Both are
  // asserted at the SHELL rather than inside the widget, because "you are now
  // in the app" and "you may not leave this screen yet" are decisions RootShell
  // makes — the screens themselves only invalidate the session query.
  it('local sign-in mounts the app in place — no redirect, no reload', async () => {
    const user = userEvent.setup();
    let authenticated = false;
    respond = (url: string) => {
      if (url.includes('/auth/local/login')) {
        authenticated = true;
        return { status: 200, body: { must_change_password: false } };
      }
      return authenticated ? signedIn(url) : signedOut(url);
    };
    renderAt('/');

    await user.type(await screen.findByTestId('signin-email'), 'admin@example.com');
    await user.type(screen.getByTestId('signin-password'), 'a good long password');
    await user.click(screen.getByTestId('signin-submit'));

    // Unlike OIDC and GitHub, which are full-page navigations, this login's
    // answer is JSON: the shell has to re-ask who the visitor is by itself.
    expect(await screen.findByTestId('rail')).toBeInTheDocument();
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  });

  it('a bootstrap admin is held on the password change, not let into the shell', async () => {
    const user = userEvent.setup();
    let pending = false;
    respond = (url: string) => {
      if (url.includes('/auth/local/login')) {
        pending = true;
        return { status: 200, body: { must_change_password: true } };
      }
      if (url.includes('/auth/local/session')) {
        return { status: 200, body: { pending_password_change: pending } };
      }
      // Everything else still 401s, because that session carries no `userId` —
      // the gate is the API's, and this screen is the only thing it can reach.
      return signedOut(url);
    };
    renderAt('/');

    await user.type(await screen.findByTestId('signin-email'), 'admin@example.com');
    await user.type(screen.getByTestId('signin-password'), 'the bootstrap password');
    await user.click(screen.getByTestId('signin-submit'));

    expect(await screen.findByTestId('password-change')).toBeInTheDocument();
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
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
    // W20-04 (UX_TODO X-02): OVER the app, not instead of it — and the app
    // underneath cannot be reached until the person signs in again.
    expect(screen.getByTestId('reauth-overlay')).toContainElement(signin);
    expect(screen.getByTestId('rail').closest('[inert]')).not.toBeNull();
    // It no longer promises what it cannot keep.
    expect(signin).not.toHaveTextContent(/nothing was lost/i);
  });

  it('keeps what was typed through a mid-use expiry and sign-in (W20-04, X-02)', async () => {
    const user = userEvent.setup();
    function Draft() {
      const { isError } = useApiQuery<Record<string, never>>({ endpoint: '/org/summary' });
      return (
        <div data-testid="home">
          <textarea data-testid="draft" aria-label="Triage note" />
          {isError ? 'failed' : 'ok'}
        </div>
      );
    }
    const { queryClient } = renderAt('/', <Draft />);
    await user.type(await screen.findByTestId('draft'), 'half a triage note');

    let authenticated = false;
    respond = (url: string) => {
      if (url.includes('/auth/local/login')) {
        authenticated = true;
        return { status: 200, body: { must_change_password: false } };
      }
      return authenticated ? signedIn(url) : signedOut(url);
    };
    await queryClient.invalidateQueries({ queryKey: queryKeyFor({ endpoint: '/org/summary' }) });
    await screen.findByTestId('reauth-overlay');

    await user.type(await screen.findByTestId('signin-email'), 'admin@example.com');
    await user.type(screen.getByTestId('signin-password'), 'a good long password');
    await user.click(screen.getByTestId('signin-submit'));

    await waitFor(() => expect(screen.queryByTestId('reauth-overlay')).not.toBeInTheDocument());
    expect(screen.getByTestId('draft')).toHaveValue('half a triage note');
    expect(screen.getByTestId('rail').closest('[inert]')).toBeNull();
    // What failed while signed out is asked again, not left as an error card.
    await waitFor(() => expect(screen.getByTestId('home')).toHaveTextContent('ok'));
  });

  it('says the server is unreachable when nothing answers, not "sign in"', async () => {
    // An outage is not a logged-out user. Turning a 502 into a sign-in wall
    // would have the product lie about why the screen is empty.
    // W20-17 (UX_TODO INS-56): and with no session behind it, the full shell
    // with an error on every card explained nothing either: one screen says
    // the server cannot be reached, with a retry.
    respond = () => ({ status: 502, body: { title: 'Bad gateway', status: 502 } });
    renderAt('/');
    expect(
      await screen.findByTestId('server-unreachable', undefined, { timeout: 8000 }),
    ).toHaveTextContent(/can’t reach its server/);
    expect(screen.getByTestId('server-unreachable-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  }, 15000);

  it('keeps the shell when only the session probe fails and /healthz is fine', async () => {
    respond = (url) =>
      url.includes('/healthz')
        ? { status: 200, body: { status: 'ok' } }
        : { status: 502, body: { title: 'Bad gateway', status: 502 } };
    renderAt('/');
    expect(await screen.findByTestId('rail', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  }, 15000);
});

// W20-04 (UX_TODO ADM-43). With Postgres or Redis down every card showed its
// own "Internal Server Error" and nothing said the server had lost its database.
describe('database or Redis down (W20-04)', () => {
  it('shows one outage screen naming what is down, instead of the app', async () => {
    respond = (url: string) =>
      url.includes('/healthz')
        ? {
            status: 503,
            body: { title: 'Service Unavailable', status: 503, detail: 'postgres=down redis=ok' },
          }
        : { status: 500, body: { title: 'Internal Server Error', status: 500 } };
    renderAt('/');
    const outage = await screen.findByTestId('outage', undefined, { timeout: 8000 });
    expect(outage).toHaveTextContent(/can’t reach its database/);
    expect(screen.getByTestId('outage-detail')).toHaveTextContent('postgres: down');
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
  }, 15000);

  // W20-10 (UX_TODO ADM-43 remainder): OutageGate only ran on the first
  // probe; an outage that began mid-session left every card on its own error.
  it('an outage that starts mid-session gets one banner, and it clears on recovery', async () => {
    function Widget() {
      const q = useApiQuery<{ v?: number }>({ endpoint: '/widget' });
      return <div data-testid="widget">{q.isError ? 'error' : 'ok'}</div>;
    }
    const { queryClient } = renderAt('/', <Widget />);
    expect(await screen.findByTestId('widget')).toHaveTextContent('ok');

    respond = (url: string) =>
      url.includes('/healthz')
        ? {
            status: 503,
            body: { title: 'Service Unavailable', status: 503, detail: 'postgres=ok redis=down' },
          }
        : url.includes('/widget')
          ? { status: 500, body: { title: 'Internal Server Error', status: 500 } }
          : signedIn(url);
    await queryClient.invalidateQueries({ queryKey: queryKeyFor({ endpoint: '/widget' }) });

    const banner = await screen.findByTestId('outage-banner', undefined, { timeout: 8000 });
    expect(banner).toHaveTextContent(/can’t reach Redis/);
    // The page is hidden, not unmounted: anything typed survives.
    expect(screen.getByTestId('widget')).not.toBeVisible();
    expect(screen.getByTestId('rail')).toBeInTheDocument();

    respond = signedIn;
    await userEvent.setup().click(screen.getByTestId('outage-banner-retry'));
    await waitFor(() => expect(screen.queryByTestId('outage-banner')).not.toBeInTheDocument(), {
      timeout: 8000,
    });
    await waitFor(() => expect(screen.getByTestId('widget')).toHaveTextContent('ok'), {
      timeout: 8000,
    });
  }, 20000);

  it('a single failing card with a healthy server shows no banner', async () => {
    function Widget() {
      const q = useApiQuery<{ v?: number }>({ endpoint: '/widget' });
      return <div data-testid="widget">{q.isError ? 'error' : 'ok'}</div>;
    }
    respond = (url: string) =>
      url.includes('/widget')
        ? { status: 500, body: { title: 'Internal Server Error', status: 500 } }
        : signedIn(url);
    renderAt('/', <Widget />);
    await waitFor(() => expect(screen.getByTestId('widget')).toHaveTextContent('error'), {
      timeout: 8000,
    });
    expect(screen.queryByTestId('outage-banner')).not.toBeInTheDocument();
  }, 15000);

  it('only a 5xx or no answer counts as a server-side failure', () => {
    expect(isServerSideFailure({ status: 503 })).toBe(true);
    expect(isServerSideFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isServerSideFailure(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
    expect(isServerSideFailure(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
  });

  it('reads what is down from the /healthz detail', () => {
    expect(downFromHealthDetail('postgres=down redis=down')).toEqual(['postgres', 'redis']);
    expect(downFromHealthDetail('postgres=ok redis=down')).toEqual(['redis']);
    expect(downFromHealthDetail(undefined)).toEqual([]);
  });
});

// W20-04 (UX_TODO ADM-04). The shell never passed isAdmin, so the rail showed
// members "Settings" and the page behind it refused them.
describe('rail by role (W20-04)', () => {
  it('a member gets their Account page where an admin gets Settings', async () => {
    respond = (url: string) =>
      url.includes('/me/context')
        ? { status: 200, body: { ...ME_CONTEXT, role: 'member' } }
        : signedIn(url);
    renderAt('/');
    expect(await screen.findByTestId('rail-account')).toHaveTextContent('Account');
    expect(screen.queryByTestId('rail-admin')).not.toBeInTheDocument();
  });

  it('an admin still gets Settings', async () => {
    renderAt('/');
    expect(await screen.findByTestId('rail-admin')).toHaveTextContent('Settings');
    expect(screen.queryByTestId('rail-account')).not.toBeInTheDocument();
  });
});

// W16-05 (F19). The trail described a screen nobody was on: `/repos/25152/security`
// read "Org › Repos", naming neither the repository nor the tab. The repository
// NAME is not in the URL, so it still cannot come from here — that crumb has to
// be contributed by the screen that loaded it — but the sub-page can, and did not.
describe('breadcrumb depth (W16-05, F19)', () => {
  it('names the sub-page, not just the section', async () => {
    renderAt('/repos/25152/security');
    const crumb = await screen.findByTestId('breadcrumb');
    await waitFor(() => expect(crumb).toHaveTextContent('Security'));
    expect(crumb).toHaveTextContent('Repos');
  });

  it('names an admin tab', async () => {
    renderAt('/admin/models');
    const crumb = await screen.findByTestId('breadcrumb');
    await waitFor(() => expect(crumb).toHaveTextContent('Models'));
  });

  it('never shows a numeric id as a crumb', async () => {
    // "Org › Repos › 25152" would be worse than saying nothing — the same
    // mistake F11 was about, in a different place.
    renderAt('/repos/25152');
    const crumb = await screen.findByTestId('breadcrumb');
    await waitFor(() => expect(crumb).toHaveTextContent('Repos'));
    expect(crumb).not.toHaveTextContent('25152');
  });
});

// W16-15. The strand, not the cause.
//
// A session naming a deleted user 500'd and the shell sat on "Checking your
// session…" for ever — no error, no retry, no sign-out, unrecoverable without
// clearing cookies. That 500 is fixed at the source, but the DEAD END is the
// class of bug and it survives any future cause, so the probe now stops
// claiming to be busy and offers a way out.
describe('the session probe cannot strand you (W16-15)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('offers a retry and a sign-out once it has waited too long', async () => {
    // A request that never settles: exactly the state that produced the strand.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderAt('/');

    expect(await screen.findByTestId('session-probe')).toBeInTheDocument();
    expect(screen.queryByTestId('session-probe-stuck')).toBeNull();

    await vi.advanceTimersByTimeAsync(7000);

    const stuck = await screen.findByTestId('session-probe-stuck');
    expect(stuck).toHaveTextContent(/longer than it should/i);
    expect(screen.getByTestId('session-probe-retry')).toBeInTheDocument();
    expect(screen.getByTestId('session-probe-signout')).toBeInTheDocument();
  });

  it('stops advertising itself as busy once it gives up waiting', async () => {
    // aria-busy on a spinner that will never finish tells a screen-reader user
    // to keep waiting for something that is not coming.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderAt('/');

    const probe = await screen.findByTestId('session-probe');
    expect(probe).toHaveAttribute('aria-busy', 'true');

    await vi.advanceTimersByTimeAsync(7000);
    await waitFor(() => expect(probe).toHaveAttribute('aria-busy', 'false'));
  });
});

describe('report viewer sign-in (W20-15, UX_TODO X-24)', () => {
  afterEach(() => {
    delete (window as unknown as { __REPORT_DATA?: unknown }).__REPORT_DATA;
  });

  it('a signed-out person opening a report link gets the sign-in screen', async () => {
    respond = signedOut;
    renderAt('/print/reports/12');
    expect(await screen.findByTestId('signin')).toBeInTheDocument();
    expect(screen.queryByTestId('print-viewer')).not.toBeInTheDocument();
  });

  it('a signed-in person sees the bare viewer, without the app chrome', async () => {
    renderAt('/print/reports/12');
    expect(await screen.findByTestId('print-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
  });

  it('the PDF pipeline (injected data) skips the session probe entirely', async () => {
    respond = signedOut;
    (window as unknown as { __REPORT_DATA?: unknown }).__REPORT_DATA = { sections: [] };
    renderAt('/print/reports/12');
    expect(await screen.findByTestId('print-viewer')).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('topbar keeps page filters (W20-15)', () => {
  it('changing the time window keeps the page-level filters in the URL', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/?window=90d&status=open&severity=5');
    const windowSelect = (await screen.findByTestId('filter-window')) as HTMLSelectElement;
    await user.selectOptions(windowSelect, '7d');
    await waitFor(() => expect(router.state.location.searchStr).toContain('window=7d'));
    expect(router.state.location.search).toMatchObject({ status: 'open', severity: 5 });
  });
});

describe('top-bar repository labels across forges (W20-15, UX_TODO X-16)', () => {
  it('names the host only when more than one forge host is connected', () => {
    const gh = { id: 1, org: 'acme', name: 'api', forge: { host: 'github.com' } };
    const gt = { id: 2, org: 'acme', name: 'api', forge: { host: 'git.corp.example' } };
    expect(topbarRepoOptions([gh]).map((o) => o.label)).toEqual(['acme/api']);
    expect(topbarRepoOptions([gh, gt]).map((o) => o.label)).toEqual([
      'acme/api · github.com',
      'acme/api · git.corp.example',
    ]);
  });
});
