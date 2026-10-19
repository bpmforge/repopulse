import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRouter } from '@tanstack/react-router';
import { createQueryClient } from '../../api/queryClient.js';
import { OrgOverview } from './OrgOverview.js';

// W20-07 (UX_TODO INS-12, INS-74). At zero repos the welcome replaced the
// whole Overview, so the admin checklist never guided the first step; and a
// member on an install with no admin was told to "ask an admin" who did not exist.

function stub(me: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url.includes('/me/context')
        ? {
            workspace: { id: 1, slug: 'default', name: 'Default' },
            identity_id: null,
            default_view_id: null,
            prefs: {},
            ...me,
          }
        : { items: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const search = { window: '30d' } as Parameters<typeof OrgOverview>[0]['search'];

function renderOverview() {
  // The checklist and the welcome CTA are router Links.
  const rootRoute = createRootRoute({ component: () => <OrgOverview search={search} /> });
  const router = createRouter({ routeTree: rootRoute });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('Overview at zero repositories (W20-07)', () => {
  it('INS-12: shows the admin checklist above the welcome, with Connect not yet ticked', async () => {
    stub({ role: 'admin', has_admin: true });
    renderOverview();
    const checklist = await screen.findByTestId('onboarding-checklist');
    expect(checklist).toHaveTextContent('Connect your organisation');
    expect(checklist).not.toHaveTextContent('(done)');
    expect(screen.getByTestId('welcome-connect')).toBeInTheDocument();
  });

  it('INS-74: a member on an install with NO admin is told what the operator must set', async () => {
    stub({ role: 'member', has_admin: false });
    renderOverview();
    expect(await screen.findByText(/no administrator yet/)).toHaveTextContent(
      /ADMIN_EMAIL and ADMIN_PASSWORD/,
    );
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });
});
