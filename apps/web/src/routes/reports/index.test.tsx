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
import {
  canRetry,
  isStalled,
  pollInterval,
  Route as reportsIndexRoute,
  STALE_AFTER_MS,
  type ReportRow,
} from './index.js';
import { createQueryClient } from '../../api/queryClient.js';

// Report Center (W17-26): terminal states stop the poll, a failed job and a
// ready-but-fileless one can be queued again, and a PDF link is only offered
// when there is a PDF.

const ME_CONTEXT = {
  workspace: { id: 1, slug: 'acme', name: 'Acme' },
  role: 'admin',
  identity_id: null,
  default_view_id: null,
  persona: 'lead',
};

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function row(over: Partial<ReportRow> & { id: number }): ReportRow {
  return {
    type: 'repo_health',
    status: 'ready',
    generated_at: new Date(NOW - 60_000).toISOString(),
    error: null,
    has_pdf: true,
    artifact_missing: false,
    ...over,
  };
}

describe('poll lifecycle (pure)', () => {
  it('polls while a young job is queued or running, and stops on every terminal state', () => {
    expect(pollInterval({ items: [row({ id: 1, status: 'queued', has_pdf: false })] }, NOW)).toBe(
      3000,
    );
    expect(pollInterval({ items: [row({ id: 1, status: 'running', has_pdf: false })] }, NOW)).toBe(
      3000,
    );
    for (const status of ['ready', 'failed', 'cancelled', 'something-new']) {
      expect(pollInterval({ items: [row({ id: 1, status })] }, NOW), status).toBe(false);
    }
    expect(pollInterval(undefined, NOW)).toBe(false);
    expect(pollInterval({ items: [] }, NOW)).toBe(false);
  });

  it('stops polling a job that has made no progress for longer than the cutoff', () => {
    // A worker killed mid-job never writes `failed`; without a cutoff its row
    // is polled for the life of the tab.
    const old = row({
      id: 1,
      status: 'running',
      has_pdf: false,
      generated_at: new Date(NOW - STALE_AFTER_MS - 1000).toISOString(),
    });
    expect(isStalled(old, NOW)).toBe(true);
    expect(pollInterval({ items: [old] }, NOW)).toBe(false);
    // But a young one beside it keeps the poll alive.
    expect(
      pollInterval({ items: [old, row({ id: 2, status: 'queued', has_pdf: false })] }, NOW),
    ).toBe(3000);
    // And a settled row is never "stalled", however old.
    expect(isStalled(row({ id: 3, generated_at: '2020-01-01T00:00:00.000Z' }), NOW)).toBe(false);
  });

  it('offers retry for a failed job and for a ready one without its PDF — nothing else', () => {
    expect(canRetry(row({ id: 1, status: 'failed', has_pdf: false, error: 'x' }))).toBe(true);
    expect(canRetry(row({ id: 1, status: 'ready', has_pdf: false, artifact_missing: true }))).toBe(
      true,
    );
    expect(canRetry(row({ id: 1, status: 'ready' }))).toBe(false);
    expect(canRetry(row({ id: 1, status: 'queued', has_pdf: false }))).toBe(false);
    expect(canRetry(row({ id: 1, status: 'running', has_pdf: false }))).toBe(false);
  });
});

let listResponse: { items: ReportRow[] };
let requests: { method: string; url: string }[];

let generateResponse: { status: number; body: unknown };

beforeEach(() => {
  listResponse = { items: [] };
  generateResponse = { status: 202, body: { id: 99 } };
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url });
      if (method === 'POST' && /\/reports$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify(generateResponse.body), {
            status: generateResponse.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const body = /\/reports\/\d+\/retry$/.test(url)
        ? { id: 1, status: 'queued' }
        : /\/reports(\?|$)/.test(url)
          ? listResponse
          : url.includes('/me/review-queue')
            ? { items: [] }
            : url.includes('/me/context')
              ? ME_CONTEXT
              : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderCenter() {
  const queryClient = createQueryClient();
  const listRoute = reportsIndexRoute.update({
    id: '/reports/',
    path: '/reports/',
    getParentRoute: () => rootRoute,
  } as never) as never as typeof reportsIndexRoute;
  const printRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/print/reports/$reportId',
    component: () => <div data-testid="print-stub" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute as never, printRoute as never]),
    context: { queryClient } satisfies RouterContext,
    history: createMemoryHistory({ initialEntries: ['/reports'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('Generate feedback (W20-04, UX_TODO ADM-08)', () => {
  it('a refused Generate says why, with the request id', async () => {
    generateResponse = {
      status: 400,
      body: { title: 'Invalid window_days', status: 400, request_id: 'req-r1' },
    };
    renderCenter();
    await userEvent.click(await screen.findByTestId('generate-report'));
    expect(await screen.findByTestId('generate-error')).toHaveTextContent('Invalid window_days');
    expect(screen.getByTestId('generate-error-request-id')).toHaveTextContent('req-r1');
    expect(screen.queryByTestId('generate-queued')).toBeNull();
  });

  it('an accepted Generate confirms it was queued', async () => {
    renderCenter();
    await userEvent.click(await screen.findByTestId('generate-report'));
    expect(await screen.findByTestId('generate-queued')).toHaveTextContent(/Queued/);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });
});

describe('Report Center rows (W17-26)', () => {
  it('a failed row shows its reason and a Retry that queues the SAME report', async () => {
    listResponse = {
      items: [row({ id: 7, status: 'failed', has_pdf: false, error: 'chromium exploded' })],
    };
    renderCenter();

    await screen.findByTestId('report-7');
    expect(screen.getByTestId('report-status-7')).toHaveTextContent(/failed/);
    expect(screen.getByTestId('report-status-7')).toHaveTextContent(/chromium exploded/);
    expect(screen.queryByTestId('report-download-7')).toBeNull();

    await userEvent.click(screen.getByTestId('report-retry-7'));
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && /\/reports\/7\/retry$/.test(r.url))).toBe(
        true,
      ),
    );
    // Never a new report: the retry carries the id, and its pinned params.
    expect(requests.some((r) => r.method === 'POST' && /\/reports$/.test(r.url))).toBe(false);
  });

  it('a ready row whose PDF is gone offers no PDF link, says why, and can be retried', async () => {
    listResponse = {
      items: [row({ id: 8, status: 'ready', has_pdf: false, artifact_missing: true })],
    };
    renderCenter();

    await screen.findByTestId('report-8');
    expect(screen.getByTestId('report-status-8')).toHaveTextContent(/ready/);
    expect(screen.getByTestId('report-artifact-missing-8')).toHaveTextContent(/no longer on disk/);
    // The old screen offered a link here — to a 410.
    expect(screen.queryByTestId('report-download-8')).toBeNull();
    expect(screen.getByTestId('report-retry-8')).toBeEnabled();
    // Viewing the stored data is still possible; only the file is gone.
    expect(screen.getByTestId('report-view-8')).toBeInTheDocument();
  });

  it('a ready row with its PDF offers View and PDF and nothing to retry', async () => {
    listResponse = { items: [row({ id: 9 })] };
    renderCenter();

    await screen.findByTestId('report-9');
    expect(screen.getByTestId('report-download-9')).toHaveAttribute(
      'href',
      '/api/v1/reports/9/download',
    );
    expect(screen.queryByTestId('report-retry-9')).toBeNull();
    expect(screen.queryByTestId('report-stalled-9')).toBeNull();
  });

  it('a settled list is fetched once and not polled', async () => {
    listResponse = {
      items: [row({ id: 10 }), row({ id: 11, status: 'failed', has_pdf: false, error: 'x' })],
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderCenter();
      await screen.findByTestId('report-10');
      const listGets = () =>
        requests.filter((r) => r.method === 'GET' && /\/reports(\?|$)/.test(r.url)).length;
      const after = listGets();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listGets()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
