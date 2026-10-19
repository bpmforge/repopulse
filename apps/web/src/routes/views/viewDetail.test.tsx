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
import { createQueryClient } from '../../api/queryClient.js';
import { Route as ViewRoute } from './$viewId.js';
import type { ViewResponse } from '../../views/contracts.js';
import '../../widgets/registerAll.js';

// W20-05 — the saved-view screen (UX_TODO DSH-02/03/04/05/06/93).

function view(id: number, patch: Partial<ViewResponse> = {}): ViewResponse {
  return {
    id,
    name: `View ${id}`,
    config: {
      repo_ids: [],
      window: '90d',
      layout: [{ id: `text-${id}`, type: 'text', layout: { x: 0, y: 0, w: 4, h: 1 } }],
    },
    is_shared: false,
    share_slug: null,
    is_default: false,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...patch,
  };
}

let views: Record<number, ViewResponse>;
let calls: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  views = { 1: view(1), 2: view(2) };
  calls = [];
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const respond = (status: number, payload?: unknown) =>
        Promise.resolve(
          status === 204
            ? new Response(null, { status })
            : new Response(JSON.stringify(payload), {
                status,
                headers: { 'content-type': 'application/json' },
              }),
        );
      const match = url.match(/\/views\/(\d+)(\/share)?/);
      if (match) {
        const id = Number(match[1]);
        if (match[2] && method === 'POST') {
          views[id] = { ...views[id]!, is_shared: true, share_slug: `slug-${calls.length}` };
          return respond(200, { share_slug: views[id]!.share_slug });
        }
        if (match[2] && method === 'DELETE') {
          views[id] = { ...views[id]!, is_shared: false, share_slug: null };
          return respond(204);
        }
        if (method === 'PATCH') {
          const b = body as { name: string; config: ViewResponse['config'] };
          views[id] = { ...views[id]!, name: b.name, config: b.config };
          return respond(200, views[id]);
        }
        if (method === 'DELETE') return respond(204);
        return respond(200, views[id]);
      }
      if (url.includes('/repos')) {
        return respond(200, {
          items: [
            { id: 7, org: 'acme', name: 'web' },
            { id: 8, org: 'acme', name: 'api' },
          ],
        });
      }
      return respond(200, {});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderView(initial: string) {
  const rootRoute = createRootRoute();
  // A file route has no path or parent until routeTree.gen.ts update()s it.
  const viewRoute = ViewRoute.update({
    id: '/views/$viewId',
    path: '/views/$viewId',
    getParentRoute: () => rootRoute,
  } as never) as never;
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/views',
    component: () => <div data-testid="views-list" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([viewRoute, listRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('saved view detail (W20-05)', () => {
  it('opening another view from inside one resets the draft (DSH-93)', async () => {
    const router = renderView('/views/1');
    await screen.findByText('View 1', { selector: 'h1' });
    fireEvent.click(screen.getByTestId('toggle-edit'));
    expect(screen.getByTestId('view-editor')).toBeInTheDocument();

    // What the command palette does: navigate while the page stays mounted.
    await act(() => router.navigate({ to: '/views/$viewId', params: { viewId: '2' } }));
    await screen.findByText('View 2', { selector: 'h1' });
    expect(screen.queryByTestId('view-editor')).toBeNull();
    expect(screen.getByTestId('widget-text-text-2')).toBeInTheDocument();
    expect(screen.queryByTestId('widget-text-text-1')).toBeNull();
  });

  it('Cancel discards the draft and Save persists it, with an unsaved marker between (DSH-05)', async () => {
    renderView('/views/1');
    await screen.findByText('View 1', { selector: 'h1' });
    fireEvent.click(screen.getByTestId('toggle-edit'));
    expect(screen.queryByTestId('unsaved-marker')).toBeNull();

    fireEvent.change(screen.getByTestId('width-text-1'), { target: { value: '9' } });
    expect(screen.getByTestId('unsaved-marker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-edit'));
    expect(screen.queryByTestId('view-editor')).toBeNull();
    // The grid shows the SAVED layout again, not the abandoned draft.
    expect(screen.getByTestId('widget-text-text-1').dataset.w).toBe('4');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    fireEvent.click(screen.getByTestId('toggle-edit'));
    fireEvent.change(screen.getByTestId('width-text-1'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('save-layout'));
    await waitFor(() => expect(screen.queryByTestId('view-editor')).toBeNull());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(
      (patch?.body as { config: { layout: { layout: { w: number } }[] } }).config.layout[0]!.layout
        .w,
    ).toBe(9);
  });

  it('renames the view and edits its scope (DSH-06), and shows the scope (DSH-02)', async () => {
    renderView('/views/1');
    await screen.findByText('View 1', { selector: 'h1' });
    expect(screen.getByTestId('view-scope').textContent).toBe('Last 90 days · all repositories');

    fireEvent.click(screen.getByTestId('toggle-edit'));
    fireEvent.change(screen.getByTestId('view-name-input'), { target: { value: 'Platform' } });
    fireEvent.change(screen.getByTestId('view-window'), { target: { value: '365d' } });
    fireEvent.click(await screen.findByTestId('view-repo-7'));
    fireEvent.click(screen.getByTestId('save-layout'));

    await screen.findByText('Platform', { selector: 'h1' });
    const patch = calls.find((c) => c.method === 'PATCH')!.body as {
      name: string;
      config: { window: string; repo_ids: number[] };
    };
    expect(patch).toMatchObject({ name: 'Platform', config: { window: '365d', repo_ids: [7] } });
    expect(screen.getByTestId('view-scope').textContent).toBe('Last 365 days · acme/web');
    // W20-09 (UX_TODO DSH-02): every tile now follows a repo scope, so a
    // one-repository view needs no caveat at all.
    expect(screen.queryByTestId('view-scope-note')).toBeNull();
  });

  it('deletes only after a confirm, then returns to the list (DSH-06)', async () => {
    renderView('/views/1');
    await screen.findByText('View 1', { selector: 'h1' });
    fireEvent.click(screen.getByTestId('delete-view'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await screen.findByTestId('views-list');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/views/1'))).toBe(true);
  });

  it('once shared, offers Copy, a confirmed Reset link and Stop sharing — not a second Share (DSH-04)', async () => {
    views[1] = view(1, { is_shared: true, share_slug: 'first' });
    renderView('/views/1');
    await screen.findByTestId('share-url');
    expect(screen.queryByTestId('share-view')).toBeNull();
    expect(screen.getByTestId('share-copy')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('share-reset'));
    // Nothing is re-minted until the owner agrees the old link will break.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(screen.getByTestId('confirm-reset-link').textContent).toMatch(/stop working/);
    fireEvent.click(screen.getByTestId('confirm-no'));

    fireEvent.click(screen.getByTestId('share-stop'));
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await screen.findByTestId('share-view');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/views/1/share'))).toBe(true);
  });

  it('a home view can be cleared from the view itself (DSH-03)', async () => {
    views[1] = view(1, { is_default: true });
    renderView('/views/1');
    await screen.findByTestId('home-label');
    fireEvent.click(screen.getByTestId('clear-home'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/me/default-view'))).toBe(
        true,
      ),
    );
  });
});
