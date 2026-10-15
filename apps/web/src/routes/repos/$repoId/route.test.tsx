import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../../__root.js';
import { Route as repoRoute } from './route.js';
import { createQueryClient } from '../../../api/queryClient.js';
import { useUiStore } from '../../../components/store/uiStore.js';

// A repository id that does not resolve is a routine URL: pasted links and
// bookmarks outlive re-seeds. The layout used to answer all of them with a bare
// "Not Found" and no navigation at all, so these tests pin both halves of the
// fix — a way onward always exists, and a 404 does not read like an outage.

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

/** What the API answers for the repo detail query; everything else succeeds. */
let repoResponse: { status: number; body: unknown };
/**
 * Repo ids whose detail request never settles — how a repository switch looks
 * for the seconds that matter: the new answer is not here yet.
 */
let pendingRepoIds: string[];

beforeEach(() => {
  repoResponse = { status: 200, body: {} };
  pendingRepoIds = [];
  // The router restores scroll on every navigation; jsdom has no scrollTo and
  // logs a stack trace per navigation, which is noise rather than a failure.
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (pendingRepoIds.some((id) => url.includes(`/repos/${id}`)))
        return new Promise<Response>(() => {});
      const { status, body } = url.includes('/repos/')
        ? repoResponse
        : url.includes('/me/review-queue')
          ? { status: 200, body: { items: [] } }
          : url.includes('/me/context')
            ? { status: 200, body: ME_CONTEXT }
            : { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  // The ui store is module-scoped: a crumb left behind here is a crumb the next
  // test inherits.
  useUiStore.getState().setEntityCrumb(null);
});

/**
 * The real layout route under the real shell, with a stub child in place of the
 * Pulse tab: the tab's own widgets would fire a dozen more queries and none of
 * them are what this file is about.
 */
function renderRepo(initialUrl: string) {
  const queryClient = createQueryClient();
  // A file route is exported with neither path nor parent — routeTree.gen.ts
  // `update()`s both in. Without repeating that here the route registers as a
  // second root and the router refuses the tree.
  const layoutRoute = repoRoute.update({
    id: '/repos/$repoId',
    path: '/repos/$repoId',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof repoRoute;
  const pulseRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/',
    component: () => <div data-testid="pulse-tab" />,
  });
  // The tabs this ticket adds, stubbed for the same reason as Pulse: what is
  // under test is the tab bar and the URL, not the widgets.
  const tabChild = (path: string, testId: string) =>
    createRoute({
      getParentRoute: () => layoutRoute,
      path,
      component: () => <div data-testid={testId} />,
    });
  const activityRoute = tabChild('/activity', 'activity-tab');
  const performanceRoute = tabChild('/performance', 'performance-tab');
  const hotspotsRoute = tabChild('/hotspots', 'hotspots-tab');
  const reposIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/',
    component: () => <div data-testid="repos-list" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      layoutRoute.addChildren([
        pulseRoute,
        activityRoute,
        performanceRoute,
        hotspotsRoute,
      ] as never) as never,
      reposIndexRoute as never,
    ]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router };
}

const problem = (status: number, title: string) => ({
  status,
  body: { type: 'about:blank', title, status, request_id: 'req-42' },
});

describe('repo detail layout — unresolvable repository id', () => {
  it('a 404 still offers a route onward instead of a dead end', async () => {
    repoResponse = problem(404, 'Not Found');
    renderRepo('/repos/999');

    const frame = await screen.findByTestId('repo-error');
    expect(frame).toBeInTheDocument();
    // The actual defect: the only navigation left was the browser back button.
    const onward = screen.getByTestId('repo-error-to-list');
    expect(onward).toHaveAttribute('href', expect.stringContaining('/repos'));
  });

  it('a 404 says which situation this is, not "Not Found"', async () => {
    repoResponse = problem(404, 'Not Found');
    renderRepo('/repos/999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cannot see a repository with id 999/i);
    expect(alert).toHaveTextContent(/another workspace/i);
    // We do not know that it was deleted, and we have no name to quote back.
    expect(alert.textContent ?? '').not.toMatch(/delet|remov/i);
    // Nothing to retry: the answer would be the same 404 every time.
    expect(screen.queryByTestId('widget-retry')).not.toBeInTheDocument();
    // Tabs are omitted here on purpose — every one of them would 404 too.
    expect(screen.queryByTestId('repo-tabs')).not.toBeInTheDocument();
  });

  it('a generic failure reads differently: it keeps the tabs and a retry', async () => {
    repoResponse = problem(502, 'Bad Gateway');
    renderRepo('/repos/999');

    // Generous timeout: a 5xx is retried with backoff (queryClient.ts), so the
    // error state is several seconds away — unlike the 404, which is final.
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert).toHaveTextContent(/could not load repository 999/i);
    expect(alert).toHaveTextContent(/Bad Gateway/);
    // An outage says nothing about whether the repository exists, so it must
    // not borrow the 404 copy.
    expect(alert.textContent ?? '').not.toMatch(/another workspace/i);
    expect(screen.getByText(/request req-42/i)).toBeInTheDocument();
    expect(screen.getByTestId('widget-retry')).toBeInTheDocument();
    // Two ways onward here: the sibling tabs may well load, plus the list.
    expect(screen.getByTestId('repo-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('repo-error-to-list')).toBeInTheDocument();
  }, 15000);

  it('a 403 reads as a permission problem, not as a missing repository', async () => {
    repoResponse = problem(403, 'Forbidden');
    renderRepo('/repos/999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not permitted to open repository 999/i);
    expect(alert).toHaveTextContent(/ask a workspace admin/i);
    // The three failures must not share copy: a refusal is not an absence and
    // not an outage.
    expect(alert.textContent ?? '').not.toMatch(/another workspace|could not load/i);
    // Signing in again is not the fix and neither is asking twice.
    expect(screen.queryByTestId('widget-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('repo-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('repo-error-to-list')).toBeInTheDocument();
  });

  it('renders the normal layout with tabs when the repository resolves', async () => {
    repoResponse = {
      status: 200,
      body: {
        id: 7,
        org: 'acme',
        name: 'web',
        health: { grade: 'B', score: 72, basis: [] },
      },
    };
    renderRepo('/repos/7');

    await waitFor(() => expect(screen.getByTestId('repo-name')).toHaveTextContent('acme/web'));
    expect(screen.getByTestId('repo-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-error')).not.toBeInTheDocument();
  });
});

/** The resolving repository every test below starts from. */
const REPO_7 = {
  status: 200,
  body: { id: 7, org: 'acme', name: 'web', health: { grade: 'B', score: 72, basis: [] } },
};

describe('repo detail layout — the workspace tabs (W17-19)', () => {
  it('offers Activity and Performance beside the tabs that already existed', async () => {
    repoResponse = REPO_7;
    renderRepo('/repos/7');

    await screen.findByTestId('repo-tabs');
    // Every previously bookmarkable tab keeps its place — the new ones are an
    // addition, not a rearrangement someone's saved link falls out of.
    for (const id of [
      'repo-tab-pulse',
      'repo-tab-activity',
      'repo-tab-performance',
      'repo-tab-hotspots',
      'repo-tab-pr-flow',
      'repo-tab-ai-reviewers',
      'repo-tab-ci',
      'repo-tab-findings',
      'repo-tab-security',
      'repo-tab-code-health',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('a pasted tab URL restores that tab and its window', async () => {
    repoResponse = REPO_7;
    renderRepo('/repos/7/performance?window=90d');

    expect(await screen.findByTestId('performance-tab')).toBeInTheDocument();
    expect(screen.getByTestId('repo-tab-performance')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('repo-tab-pulse')).not.toHaveAttribute('data-active');
    // The window rides the tab links, or moving between tabs silently resets
    // the reader's filter to the default.
    expect(screen.getByTestId('repo-tab-activity')).toHaveAttribute(
      'href',
      expect.stringContaining('window=90d'),
    );
  });

  it('back returns to the tab and window you came from', async () => {
    repoResponse = REPO_7;
    const { router } = renderRepo('/repos/7/performance?window=90d');
    await screen.findByTestId('performance-tab');

    await act(async () => {
      await router.navigate({ to: '/repos/$repoId/activity', params: { repoId: '7' } } as never);
    });
    expect(await screen.findByTestId('activity-tab')).toBeInTheDocument();

    await act(async () => {
      router.history.back();
    });

    await waitFor(() =>
      expect(screen.getByTestId('repo-tab-performance')).toHaveAttribute('data-active', 'true'),
    );
    expect(screen.getByTestId('performance-tab')).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ window: '90d' });
  });
});

describe('repo detail layout — switching repositories', () => {
  it('drops the previous repository name, health and crumb while the next loads', async () => {
    repoResponse = REPO_7;
    const { router } = renderRepo('/repos/7');
    await waitFor(() => expect(screen.getByTestId('repo-name')).toHaveTextContent('acme/web'));
    await waitFor(() => expect(useUiStore.getState().entityCrumb?.label).toBe('web'));

    // The next repository's answer has not arrived. keepPreviousData used to
    // fill the gap with the LAST repository's name, health grade and crumb —
    // a confident answer about the wrong repository.
    pendingRepoIds = ['8'];
    await act(async () => {
      await router.navigate({ to: '/repos/$repoId', params: { repoId: '8' } } as never);
    });

    await waitFor(() => expect(screen.getByTestId('repo-name')).not.toHaveTextContent('acme/web'));
    expect(screen.getByTestId('repo-name')).toHaveTextContent('Loading');
    expect(screen.queryByTestId('health-why')).not.toBeInTheDocument();
    expect(useUiStore.getState().entityCrumb).toBeNull();
  });

  it('keeps the tab you were on when you switch repositories', async () => {
    repoResponse = REPO_7;
    const { router } = renderRepo('/repos/7/activity');
    await screen.findByTestId('activity-tab');

    pendingRepoIds = ['8'];
    await act(async () => {
      await router.navigate({ to: '/repos/$repoId/activity', params: { repoId: '8' } } as never);
    });

    expect(screen.getByTestId('activity-tab')).toBeInTheDocument();
    expect(screen.getByTestId('repo-tab-activity')).toHaveAttribute('data-active', 'true');
  });
});
