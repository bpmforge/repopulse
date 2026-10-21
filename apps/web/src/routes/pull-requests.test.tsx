import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createQueryClient } from '../api/queryClient.js';
import {
  Route as PrsRoute,
  popPage,
  pushPage,
  repoIdParam,
  validatePrListSearch,
} from './pull-requests.js';

// W20-05 (UX_TODO DSH-13). The filters and page lived in component state, so
// Back from a pull request reset them; a multi-repo filter was a 400.

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: 'c2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('PR list search', () => {
  it('keeps known filters and drops junk', () => {
    expect(
      validatePrListSearch({ state: 'merged', size: 'XL', stale: 'true', cursor: 'abc' }),
    ).toEqual({ state: 'merged', size: 'XL', stale: true, cursor: 'abc' });
    expect(validatePrListSearch({ state: 'nope', size: 'XXL', unreviewed: 'no' })).toEqual({});
  });

  it('passes the topbar csv through, and `all` as no filter', () => {
    expect(repoIdParam('3,4')).toBe('3,4');
    expect(repoIdParam('all')).toBeUndefined();
    expect(repoIdParam(undefined)).toBeUndefined();
  });
});

function renderPrs(initial: string) {
  const rootRoute = createRootRoute();
  const prs = PrsRoute.update({
    id: '/pull-requests',
    path: '/pull-requests',
    getParentRoute: () => rootRoute,
  } as never) as never;
  const other = createRoute({
    getParentRoute: () => rootRoute,
    path: '/elsewhere',
    component: () => <div data-testid="elsewhere" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([prs, other]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('PR list filters live in the URL', () => {
  it('a filter change writes the URL and survives Back', async () => {
    const router = renderPrs('/pull-requests?repos=3,4');
    await screen.findByTestId('pr-filters');
    // A two-repository filter is one CSV parameter, not a 400.
    await waitFor(() => expect(urls.some((u) => u.includes('repo_id=3%2C4'))).toBe(true));

    fireEvent.change(screen.getByTestId('pr-filter-state'), { target: { value: 'merged' } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ state: 'merged' }));
    fireEvent.click(screen.getByTestId('pr-filter-stale'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ stale: true }));

    await act(() => router.navigate({ to: '/elsewhere' }));
    await act(() => router.history.back());
    await screen.findByTestId('pr-filters');
    expect((screen.getByTestId('pr-filter-state') as HTMLSelectElement).value).toBe('merged');
    expect((screen.getByTestId('pr-filter-stale') as HTMLInputElement).checked).toBe(true);
  });

  it('paging puts the cursor in the URL, and a filter change drops it', async () => {
    const router = renderPrs('/pull-requests');
    fireEvent.click(await screen.findByTestId('pr-next-page'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ cursor: 'c2' }));
    fireEvent.change(screen.getByTestId('pr-filter-size'), { target: { value: 'S' } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ size: 'S' }));
    expect(router.state.location.search).not.toHaveProperty('cursor');
  });
});

describe('paging back as well as forward (W20-12, UX_TODO DSH-45)', () => {
  it('keeps a cursor history and pops it, with ~ for the first page', () => {
    const afterFirst = pushPage(undefined, undefined);
    expect(afterFirst).toBe('~');
    const afterSecond = pushPage(afterFirst, '100:7');
    expect(afterSecond).toBe('~,100:7');
    expect(popPage(afterSecond)).toEqual({ cursor: '100:7', prev: '~' });
    expect(popPage('~')).toEqual({});
  });

  it('drops a malformed history rather than failing the page', () => {
    expect(validatePrListSearch({ prev: '~,100:7' })).toEqual({ prev: '~,100:7' });
    expect(validatePrListSearch({ prev: '<script>' })).toEqual({});
  });
});

describe('sorting (W20-20, UX_TODO DSH-45)', () => {
  it('keeps a known sort in the URL and drops the default and junk', () => {
    expect(validatePrListSearch({ sort: 'opened:asc' })).toEqual({ sort: 'opened:asc' });
    expect(validatePrListSearch({ sort: 'updated:desc' })).toEqual({});
    expect(validatePrListSearch({ sort: 'title:asc' })).toEqual({});
  });

  it('a sort change asks the API for it and starts from the first page', async () => {
    const router = renderPrs('/pull-requests?cursor=c2');
    fireEvent.change(await screen.findByTestId('pr-sort'), { target: { value: 'opened:asc' } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sort: 'opened:asc' }));
    expect(router.state.location.search).not.toHaveProperty('cursor');
    await waitFor(() => expect(urls.some((u) => u.includes('sort=opened%3Aasc'))).toBe(true));
  });
});

describe('reviewer drill-down (W20-20, UX_TODO DSH-30)', () => {
  it('keeps a login and drops anything that is not one', () => {
    expect(validatePrListSearch({ reviewer: 'alice-b' })).toEqual({ reviewer: 'alice-b' });
    expect(validatePrListSearch({ reviewer: 'copilot[bot]' })).toEqual({
      reviewer: 'copilot[bot]',
    });
    expect(validatePrListSearch({ reviewer: 'a b<script>' })).toEqual({});
  });

  it('asks the API for that reviewer’s PRs and shows the filter with a way out', async () => {
    renderPrs('/pull-requests?reviewer=alice');
    expect(await screen.findByTestId('pr-filter-reviewer')).toHaveTextContent('Reviewed by alice');
    await waitFor(() => expect(urls.some((u) => u.includes('reviewer=alice'))).toBe(true));
  });
});
