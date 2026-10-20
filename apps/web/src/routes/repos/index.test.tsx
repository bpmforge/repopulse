import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { Route as rootRoute, type RouterContext } from '../__root.js';
import { Route as reposIndexRoute } from './index.js';
import { createQueryClient } from '../../api/queryClient.js';

// W17-18. The repository list was the one screen in the product that could not
// answer "which of these two is which?" — it rendered `repo.name` alone, off an
// org rollup endpoint that has no org — and it presented an unmeasured repo's
// health as a hard 0. These tests pin the four things that were wrong.

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

interface RepoFixture {
  id: number;
  org: string;
  name: string;
  score: number | null;
}

function repoItem(r: RepoFixture) {
  const measured = r.score !== null;
  return {
    id: r.id,
    org: r.org,
    name: r.name,
    sync: 'live',
    health: {
      score: r.score,
      letter: measured ? 'C' : null,
      measured,
      basis: measured ? 'Tier-1 only' : 'not measured',
      delta: null,
    },
    links: { self: `/api/v1/repos/${r.id}` },
  };
}

/** What GET /repos answers; every other query succeeds emptily. */
let reposResponse: { status: number; body: unknown };

function setRepos(...repos: RepoFixture[]): void {
  reposResponse = { status: 200, body: { items: repos.map(repoItem) } };
}

beforeEach(() => {
  setRepos();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      // `/repos?...` — the list. Not `/repos/123`, which nothing here calls.
      const { status, body } = /\/repos(\?|$)/.test(url)
        ? reposResponse
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
afterEach(() => vi.unstubAllGlobals());

function renderList(initialUrl = '/repos') {
  const queryClient = createQueryClient();
  // A file route is exported with neither path nor parent — routeTree.gen.ts
  // `update()`s both in (the same dance $repoId/route.test.tsx does).
  const listRoute = reposIndexRoute.update({
    id: '/repos/',
    path: '/repos/',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof reposIndexRoute;
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId',
    component: () => <div data-testid="repo-detail" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute as never, detailRoute as never]),
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

const rowNames = () =>
  screen.getAllByTestId('repo-row-name').map((el) => el.textContent?.trim() ?? '');

describe('repository list (W17-18)', () => {
  it('tells two repositories with the same name apart by their org', async () => {
    setRepos(
      { id: 1, org: 'acme', name: 'api', score: 80 },
      { id: 2, org: 'globex', name: 'api', score: 40 },
    );
    renderList();

    await screen.findByTestId('repo-list');
    // The defect: both rows read "api" and nothing else, so the only way to
    // tell which was which was to click one and read the URL.
    const orgs = screen.getAllByTestId('repo-row-org').map((el) => el.textContent?.trim());
    expect(orgs).toEqual(expect.arrayContaining(['acme', 'globex']));
    // A screen reader reads the link, not the two spans beside each other, so
    // the org has to be inside the accessible name — otherwise the list is two
    // identical links.
    expect(screen.getByTestId('repo-row-1')).toHaveAccessibleName(/acme.*api/);
    expect(screen.getByTestId('repo-row-2')).toHaveAccessibleName(/globex.*api/);
  });

  it('sorts unknown health LAST in both directions, never as a zero', async () => {
    setRepos(
      { id: 1, org: 'acme', name: 'high', score: 90 },
      { id: 2, org: 'acme', name: 'unknown', score: null },
      { id: 3, org: 'acme', name: 'low', score: 10 },
    );
    const { router } = renderList('/repos?sort=health%3Adesc');

    await screen.findByTestId('repo-list');
    expect(rowNames()).toEqual(['high', 'low', 'unknown']);
    // The unknown row shows no number at all.
    const unknownRow = screen.getByTestId('repo-row-2');
    expect(unknownRow.querySelector('[data-band]')?.getAttribute('data-band')).toBe('none');

    // Ascending is the direction that exposes a `score ?? 0` implementation:
    // it would rank the unmeasured repo as the very worst in the workspace.
    await router.navigate({ to: '/repos', search: { sort: 'health:asc' } as never });
    await waitFor(() => expect(rowNames()).toEqual(['low', 'high', 'unknown']));
  });

  it('keeps sort and text filter in the URL, and they survive a trip to a repo and back', async () => {
    const user = userEvent.setup();
    setRepos(
      { id: 1, org: 'acme', name: 'api', score: 90 },
      { id: 2, org: 'globex', name: 'web', score: 40 },
    );
    const { router } = renderList('/repos?sort=health%3Adesc&q=glob');

    await screen.findByTestId('repo-list');
    // The filter narrows, and it matches on org too — "glob" is not in a name.
    expect(rowNames()).toEqual(['web']);
    expect((screen.getByTestId('repo-list-filter') as HTMLInputElement).value).toBe('glob');

    await user.click(screen.getByTestId('repo-row-2'));
    await screen.findByTestId('repo-detail');

    router.history.back();
    await screen.findByTestId('repo-list');
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ sort: 'health:desc', q: 'glob' });
    });
    expect(rowNames()).toEqual(['web']);
  });

  it('a workspace with no repositories says what to do about it', async () => {
    setRepos();
    renderList();

    await screen.findByTestId('widget-state-empty');
    expect(screen.getByTestId('widget-state-empty')).toHaveTextContent(/no repositories/i);
    // A dead end was the whole complaint: there is now a way to connect one.
    const action = screen.getByTestId('repo-list-connect');
    expect(action).toHaveAttribute('href', expect.stringContaining('/setup'));
  });

  it('a filter that matches nothing is NOT "no repositories connected"', async () => {
    setRepos({ id: 1, org: 'acme', name: 'api', score: 90 });
    renderList('/repos?q=zzz');

    await screen.findByTestId('widget-state-empty');
    const empty = screen.getByTestId('widget-state-empty');
    // The old screen said the workspace was empty, which was a lie the user
    // could not distinguish from a broken connection.
    expect(empty).toHaveTextContent(/no repositor(y|ies) match/i);
    expect(empty.textContent ?? '').not.toMatch(/connected yet/i);
    expect(screen.queryByTestId('repo-list-connect')).not.toBeInTheDocument();
    await screen.findByTestId('repo-list-clear-filter');
  });

  it('a failed query is reportable: message, request id, retry', async () => {
    reposResponse = {
      status: 503,
      body: {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'the warehouse is unreachable',
        request_id: 'req-w1718',
      },
    };
    renderList();

    // 5xx is retried twice with backoff before the frame gives up (see
    // createQueryClient) — the wait is the real product behaviour, not slack.
    const alert = await screen.findByRole('alert', {}, { timeout: 8000 });
    expect(alert).toBeInTheDocument();
    // W16-18: the request id is what makes "it broke" findable in a log. The
    // list passed `errorMessage` explicitly, which suppressed the derived path.
    expect(screen.getByTestId('error-request-id')).toHaveTextContent('req-w1718');
    expect(screen.getByTestId('widget-retry')).toBeInTheDocument();
  }, 15000);
});

// W20-15 (UX_TODO X-16): with several forges connected, no screen said which
// forge a repository came from, and a mirror tracked twice went unremarked.
describe('repositories across forges (W20-15, UX_TODO X-16)', () => {
  it('names the forge host on each row and warns about a repository tracked twice', async () => {
    reposResponse = {
      status: 200,
      body: {
        items: [
          {
            ...repoItem({ id: 1, org: 'acme', name: 'api', score: 80 }),
            forge: { provider: 'github', host: 'github.com' },
            tracked_twice: true,
          },
          {
            ...repoItem({ id: 2, org: 'acme', name: 'api', score: 70 }),
            forge: { provider: 'gitea', host: 'git.corp.example' },
            tracked_twice: true,
          },
        ],
      },
    };
    renderList();
    await screen.findByTestId('repo-list');
    const forges = screen.getAllByTestId('repo-row-forge').map((el) => el.textContent?.trim());
    expect(forges).toEqual(expect.arrayContaining(['· github.com', '· gitea · git.corp.example']));
    expect(screen.getByTestId('repo-list-duplicates')).toHaveTextContent(
      /more than one connection: acme\/api\. .*counted twice/,
    );
  });
});
