import { render, screen } from '@testing-library/react';
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
import { RepoActivity } from './RepoActivity.js';

// The Activity tab is a DIGEST of analyses other tabs own (W17-19): it must
// show the head of each list and link onward, and it must not invent an event
// feed of its own. These tests pin the composition and the links; the numbers
// are the other tabs' to test.

const PRS = {
  items: Array.from({ length: 7 }, (_, i) => ({
    number: 100 + i,
    title: `PR ${100 + i}`,
    state: i === 0 ? 'open' : 'merged',
    size_bucket: 'S',
    review_covered: i !== 0,
    links: { self: `/api/v1/repos/7/prs/${100 + i}` },
  })),
};

const CI = {
  window: '30d',
  computed_at: '2026-09-01T00:00:00Z',
  pass_rate: 0.925,
  pr_pass_rate: 0.8,
  default_branch_runs: 40,
  pr_runs: 120,
  duration: { medianMs: 300_000, p90Ms: 600_000 },
  flakiest: [{ workflow: 'e2e', flakiness: null, rerun_groups: 0, flipped_groups: 0 }],
  flakiness_workflows: 1,
  components_available: true,
};

const HOTSPOTS = {
  items: Array.from({ length: 6 }, (_, i) => ({
    path: `src/mod${i}/file.ts`,
    hotspot_score: 0.9 - i * 0.1,
    links: { file: `/api/v1/repos/7/files/src%2Fmod${i}%2Ffile.ts` },
  })),
};

let responses: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
  responses = {
    '/prs': { status: 200, body: PRS },
    '/ci': { status: 200, body: CI },
    '/hotspots': { status: 200, body: HOTSPOTS },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const hit = Object.entries(responses).find(([suffix]) => url.includes(`/repos/7${suffix}`));
      const { status, body } = hit?.[1] ?? { status: 200, body: {} };
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

/** A bare router: the widget renders Links, which need a router to resolve. */
function renderActivity() {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/activity',
    component: () => <RepoActivity repoId="7" window="30d" search={{ window: '30d' }} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/repos/7/activity?window=30d'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('RepoActivity (W17-19)', () => {
  it('shows the head of the PR list and links to the whole of it', async () => {
    renderActivity();
    expect(await screen.findByText('PR 100')).toBeInTheDocument();
    // Five, not seven: a digest, with the full list one link away.
    expect(screen.getByText('PR 104')).toBeInTheDocument();
    expect(screen.queryByText('PR 105')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-to-prs')).toHaveAttribute(
      'href',
      expect.stringMatching(/\/repos\/7\/prs\?.*window=30d/),
    );
    // Each row deep-links to its PR, window preserved.
    expect(screen.getByText('#100').closest('a')).toHaveAttribute(
      'href',
      expect.stringMatching(/\/repos\/7\/prs\/100\?.*window=30d/),
    );
    expect(screen.getByText(/unreviewed/)).toBeInTheDocument();
  });

  it('summarises CI from the CI endpoint and links to the CI tab', async () => {
    renderActivity();
    expect(await screen.findByText('93%')).toBeInTheDocument();
    expect(screen.getByText('40 main · 120 PR')).toBeInTheDocument();
    // flakiness null = never rerun: the workflow is named with no percentage,
    // not shown as 0%.
    expect(screen.getByText('e2e')).toBeInTheDocument();
    expect(screen.queryByText(/e2e \(/)).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-to-ci')).toHaveAttribute(
      'href',
      expect.stringContaining('/repos/7/ci'),
    );
  });

  it('lists the hottest files with drill-down links and the Hotspots tab', async () => {
    renderActivity();
    expect(await screen.findByText('src/mod0/file.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/mod5/file.ts')).not.toBeInTheDocument();
    expect(screen.getByText('src/mod0/file.ts').closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/repos/7/files/src/mod0/file.ts'),
    );
    expect(screen.getByTestId('activity-to-hotspots')).toHaveAttribute(
      'href',
      expect.stringContaining('/repos/7/hotspots'),
    );
    expect(screen.getByTestId('activity-to-pr-flow')).toHaveAttribute(
      'href',
      expect.stringContaining('/repos/7/pr-flow'),
    );
  });

  it('a failing section fails alone: the other sections still render', async () => {
    responses['/ci'] = {
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404 },
    };
    renderActivity();
    expect(await screen.findByText('PR 100')).toBeInTheDocument();
    expect(await screen.findByText('src/mod0/file.ts')).toBeInTheDocument();
    const ci = await screen.findByTestId('activity-ci');
    expect(ci.querySelector('[data-testid="widget-state-error"]')).not.toBeNull();
    // Onward link survives the failure — it may well load on its own tab.
    expect(screen.getByTestId('activity-to-ci')).toBeInTheDocument();
  });
});
