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
  compareOrder,
  historyQuery,
  historyRangeText,
  reportLabel,
  isStalled,
  pollInterval,
  retriedAt,
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
let requests: { method: string; url: string; body?: unknown }[];
let schedules: { items: unknown[] };
let role = 'admin';
const REPOS = {
  items: [
    { id: 3, org: 'acme', name: 'api' },
    { id: 4, org: 'acme', name: 'web' },
  ],
};

let generateResponse: { status: number; body: unknown };

beforeEach(() => {
  listResponse = { items: [] };
  schedules = { items: [] };
  role = 'admin';
  generateResponse = { status: 202, body: { id: 99 } };
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === 'POST' && /\/plans$/.test(url)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: 12, item_count: 2, reused: false, repo_ids: [3], window: '90d' }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
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
        : /\/reports\/schedules/.test(url)
          ? schedules
          : /\/reports(\?|$)/.test(url)
            ? listResponse
            : /\/repos(\?|$)/.test(url)
              ? REPOS
              : url.includes('/me/review-queue')
                ? { items: [] }
                : url.includes('/me/context')
                  ? { ...ME_CONTEXT, role }
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

function renderCenter(initial = '/reports') {
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
    history: createMemoryHistory({ initialEntries: [initial] }),
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

  it('offers View only on a ready row (W20-17, ADM-22)', async () => {
    listResponse = {
      items: [row({ id: 12 }), row({ id: 13, status: 'failed', has_pdf: false, error: 'x' })],
    };
    renderCenter();

    await screen.findByTestId('report-12');
    expect(screen.getByTestId('report-view-12')).toBeInTheDocument();
    expect(screen.queryByTestId('report-view-13')).toBeNull();
    expect(screen.getByTestId('report-generated-12')).toHaveTextContent(/ago|just now/);
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

describe('Report scope, regenerate, plan and schedules (W20-09)', () => {
  const posts = (re: RegExp) => requests.filter((r) => r.method === 'POST' && re.test(r.url));

  it('starts from the topbar filter and sends the repository set (ADM-05)', async () => {
    renderCenter('/reports?repos=4');
    // One repository in the filter: that repository's health report.
    expect(await screen.findByTestId('report-repo')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('report-repo')).toHaveValue('4'));
    await userEvent.click(screen.getByTestId('generate-report'));
    await waitFor(() => expect(posts(/\/reports$/)).toHaveLength(1));
    expect(posts(/\/reports$/)[0]!.body).toMatchObject({ type: 'repo_health', repo_ids: [4] });
  });

  it('a set-scoped report sends the ticked repositories; none = all (ADM-05)', async () => {
    renderCenter();
    await screen.findByTestId('report-repos');
    await userEvent.click(screen.getByTestId('report-repos-summary'));
    await userEvent.click(await screen.findByTestId('report-repo-3'));
    expect(screen.getByTestId('report-repos-summary')).toHaveTextContent('acme/api');
    await userEvent.click(screen.getByTestId('generate-report'));
    await waitFor(() => expect(posts(/\/reports$/)).toHaveLength(1));
    expect(posts(/\/reports$/)[0]!.body).toMatchObject({ type: 'org_exec', repo_ids: [3] });
  });

  it('Repository Health cannot be generated without choosing its repository', async () => {
    renderCenter();
    await userEvent.selectOptions(await screen.findByTestId('report-type'), 'repo_health');
    expect(screen.getByTestId('generate-report')).toBeDisabled();
  });

  it('history says scope, window and who generated it (ADM-05)', async () => {
    listResponse = {
      items: [
        row({ id: 20, params: { repoIds: ['3'], windowDays: 90 }, generated_by: 'dana' }),
        row({ id: 21, params: { repoIds: [], windowDays: 30 }, generated_by: null }),
      ],
    };
    renderCenter();
    await screen.findByTestId('report-20');
    await waitFor(() =>
      expect(screen.getByTestId('report-scope-20')).toHaveTextContent('acme/api'),
    );
    expect(screen.getByTestId('report-window-20')).toHaveTextContent('90d');
    expect(screen.getByTestId('report-by-20')).toHaveTextContent('dana');
    expect(screen.getByTestId('report-scope-21')).toHaveTextContent('All repositories');
  });

  it('Regenerate queues a NEW report with the same scope (ADM-06)', async () => {
    listResponse = {
      items: [
        row({
          id: 22,
          type: 'org_exec',
          params: { repoIds: ['3', '4'], windowDays: 90, annotation: 'Q3' },
        }),
      ],
    };
    renderCenter();
    await userEvent.click(await screen.findByTestId('report-regenerate-22'));
    await waitFor(() => expect(posts(/\/reports$/)).toHaveLength(1));
    expect(posts(/\/reports$/)[0]!.body).toEqual({
      type: 'org_exec',
      window_days: 90,
      annotation: 'Q3',
      repo_ids: [3, 4],
    });
    // Never the retry path: regenerate is a new report measured now.
    expect(posts(/\/retry$/)).toHaveLength(0);
  });

  it('Make a plan uses the report’s window and repositories (DSH-59)', async () => {
    listResponse = { items: [row({ id: 23, params: { repoIds: ['3'], windowDays: 90 } })] };
    renderCenter();
    await userEvent.click(await screen.findByTestId('report-make-plan-23'));
    await waitFor(() => expect(posts(/\/plans$/)).toHaveLength(1));
    expect(posts(/\/plans$/)[0]!.body).toEqual({
      window: '90d',
      repo_ids: [3],
      from_report_id: 23,
    });
    expect(await screen.findByTestId('report-plan-link-23')).toHaveTextContent('Plan #12');
  });

  it('an admin can list, add and remove schedules (ADM-07)', async () => {
    schedules = {
      items: [
        {
          key: 'k:1',
          type: 'org_exec',
          cadence: 'monthly',
          next: Date.parse('2026-11-01T03:00:00Z'),
          windowDays: 30,
        },
      ],
    };
    renderCenter();
    const existing = await screen.findByTestId('schedule-org_exec-monthly');
    expect(existing).toHaveTextContent('30 days');
    expect(existing).toHaveTextContent('2026-11-01 03:00');

    await userEvent.selectOptions(screen.getByTestId('schedule-type'), 'security_posture');
    await userEvent.selectOptions(screen.getByTestId('schedule-cadence'), 'quarterly');
    await userEvent.selectOptions(screen.getByTestId('schedule-window'), '90');
    await userEvent.click(screen.getByTestId('schedule-add'));
    await waitFor(() => expect(posts(/\/reports\/schedules$/)).toHaveLength(1));
    expect(posts(/\/reports\/schedules$/)[0]!.body).toEqual({
      type: 'security_posture',
      cadence: 'quarterly',
      window_days: 90,
    });

    await userEvent.click(screen.getByTestId('schedule-remove-org_exec-monthly'));
    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/reports/schedules/k%3A1')),
      ).toBe(true),
    );
  });

  it('a member sees no Schedules panel', async () => {
    role = 'member';
    renderCenter();
    await screen.findByTestId('report-center');
    await waitFor(() => expect(requests.some((r) => r.url.includes('/me/context'))).toBe(true));
    expect(screen.queryByTestId('report-schedules')).toBeNull();
  });
});

// W20-19 (UX_TODO ADM-61, ADM-72; decision 2026-10-20).
describe('Retried and deleted reports (W20-19)', () => {
  it('a retry is dated by its queueing, not by the original request', () => {
    const old = new Date(NOW - 30 * 24 * 3600_000).toISOString();
    const fresh = new Date(NOW - 60_000).toISOString();
    const retried = row({
      id: 1,
      status: 'queued',
      has_pdf: false,
      generated_at: old,
      queued_at: fresh,
    });
    expect(isStalled(retried, NOW)).toBe(false);
    expect(retriedAt(retried)).toBe(fresh);
    const same = row({ id: 2 });
    expect(retriedAt({ ...same, queued_at: same.generated_at })).toBeNull();
    expect(retriedAt(row({ id: 3 }))).toBeNull();
  });

  it('an admin deletes a report after confirming; never one being printed', async () => {
    listResponse = {
      items: [row({ id: 21 }), row({ id: 22, status: 'running', has_pdf: false })],
    };
    renderCenter();
    await userEvent.click(await screen.findByTestId('report-delete-21'));
    expect(screen.queryByTestId('report-delete-22')).toBeNull();
    expect(screen.getByTestId('report-delete-confirm-21')).toHaveTextContent(/cannot be undone/);
    await userEvent.click(screen.getByTestId('report-delete-do-21'));
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'DELETE' && /\/reports\/21$/.test(r.url))).toBe(
        true,
      ),
    );
  });

  it('a member is offered no Delete', async () => {
    role = 'member';
    listResponse = { items: [row({ id: 23 })] };
    renderCenter();
    await screen.findByTestId('report-23');
    await waitFor(() => expect(requests.some((r) => r.url.includes('/me/context'))).toBe(true));
    expect(screen.queryByTestId('report-delete-23')).toBeNull();
  });
});

// W20-22 (UX_TODO ADM-25, ADM-52): compare is labelled by type and date and
// ordered by date; history is paged with a type and date filter.
describe('compare and history paging (W20-22)', () => {
  it('labels a report by type and date, and orders a pair older first', () => {
    const a = row({ id: 9, generated_at: '2026-09-01T10:00:00.000Z' });
    const b = row({ id: 3, generated_at: '2026-08-01T10:00:00.000Z' });
    expect(reportLabel(a)).toMatch(/^Repository Health, /);
    expect(compareOrder(a, b).map((r) => r.id)).toEqual([3, 9]);
    expect(compareOrder(b, a).map((r) => r.id)).toEqual([3, 9]);
  });

  it('sends only the filters that are set, and says which slice is shown', () => {
    expect(historyQuery({ type: '', since: '', until: '' }, null)).toEqual({ limit: '50' });
    expect(historyQuery({ type: 'org_exec', since: '2026-01-01', until: '' }, 'c1')).toEqual({
      limit: '50',
      type: 'org_exec',
      since: '2026-01-01',
      cursor: 'c1',
    });
    expect(historyRangeText(0, 50, 230)).toBe('Showing 1–50 of 230');
    expect(historyRangeText(50, 20, undefined)).toBe('Showing 51–70');
    expect(historyRangeText(0, 0, 0)).toBe('');
  });
});
