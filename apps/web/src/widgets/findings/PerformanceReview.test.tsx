import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { Route as performanceRoute } from '../../routes/repos/$repoId/performance.js';
import type { Finding } from './contracts.js';
import type { CapabilityRow, RepoCapabilities } from './performance.js';

// The Performance tab, honest (W17-21).
//
// The fixture finding below is the seeded one (packages/shared/src/testing/
// seed: "Query inside a loop over pull requests", scanner `performance`). It
// must open from the URL, survive a reload with its evidence and
// recommendation intact, and the page around it must never print a number it
// did not measure — which for a product that never runs the code is every
// runtime number there is.

const FIXTURE: Finding = {
  id: 2,
  repo: { id: 7, org: 'acme', name: 'web' },
  dimension: 'performance',
  severity: 4,
  confidence: 4,
  title: 'Query inside a loop over pull requests',
  file: 'src/reports/build.ts',
  line_range: [12, 14],
  evidence: 'for (const pr of prs) { await db.select().from(reviews) }',
  recommendation: 'Batch the lookup outside the loop.',
  status: 'open',
  dismiss_reason: null,
  occurrence_count: 1,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  last_seen_at: '2026-09-09T00:00:00.000Z',
  tier: 1,
  verify_status: 'unverified',
  scanner_key: 'performance',
  rule_id: 'bpm-perf-query-in-loop',
  forge: null,
};

const cap = (over: Partial<CapabilityRow>): CapabilityRow => ({
  id: 'performance',
  label: 'performance',
  kind: 'scanner',
  state: 'succeeded',
  last_success_at: '2026-09-09T10:00:00Z',
  latest_run_id: 41,
  last_success_ref: '3308dbe0000000000000',
  stale: false,
  detail: 'Completed.',
  ...over,
});
const AI_OFF = cap({
  id: 'ai_review',
  label: 'AI code review',
  kind: 'ai_review',
  state: 'not_configured',
  last_success_at: null,
  latest_run_id: null,
  last_success_ref: null,
  detail: 'No model is enabled for this workspace.',
});
const METADATA = cap({
  id: 'metadata',
  label: 'Repository metadata and delivery history',
  kind: 'metadata',
  last_success_ref: null,
});

const capabilities = (rows: CapabilityRow[]): RepoCapabilities => ({
  repo_id: 7,
  checked_at: '2026-09-10T00:00:00Z',
  freshness_hours: 24,
  capabilities: rows,
});

let caps: RepoCapabilities;
let items: Finding[];
let history: { items: unknown[] };
let requests: string[];

beforeEach(() => {
  caps = capabilities([METADATA, cap({}), AI_OFF]);
  items = [FIXTURE];
  history = { items: [] };
  requests = [];
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      requests.push(url);
      const body = url.includes('/repos/7/capabilities')
        ? caps
        : url.includes('/findings/2/history')
          ? history
          : url.includes('/findings?')
            ? { items, next_cursor: null }
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

/** A fresh router + query client: what a browser reload is, as far as React knows. */
function renderPerformance(url = '/repos/7/performance') {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/performance',
    validateSearch: performanceRoute.options.validateSearch as never,
    component: performanceRoute.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route as never]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

const RUNTIME_NUMBER = /\d+(\.\d+)?\s*(ms|µs|ns|s|sec|m|min|%|MB|GB|KB|req\/s|rps|qps|ops)\b/i;
const RUNTIME_WORDS = /\b(latency|throughput|cpu|memory|p9\d|median|percentile)\b/i;
// A runtime word in the same sentence as a digit is a runtime CLAIM.
const RUNTIME_CLAIM =
  /\d[^.]*\b(latency|throughput|cpu|memory|percentile)\b|\b(latency|throughput|cpu|memory|percentile)\b[^.]*\d/i;

describe('Performance tab — a fixture finding opens and survives a reload', () => {
  it('opens the seeded finding from a click, writes it to the URL, and shows evidence + recommendation', async () => {
    const { router } = renderPerformance();
    fireEvent.click(await screen.findByTestId('finding-open-2'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ finding: 2 }));
    const detail = await screen.findByTestId('finding-detail');
    expect(detail).toHaveTextContent(FIXTURE.evidence);
    expect(detail).toHaveTextContent(FIXTURE.recommendation);
    expect(detail).toHaveTextContent('src/reports/build.ts:12–14');
  });

  it('reloading the URL with ?finding= lands on the same evidence and recommendation', async () => {
    const first = renderPerformance('/repos/7/performance?finding=2');
    expect(await screen.findByTestId('finding-detail')).toHaveTextContent(FIXTURE.evidence);
    first.unmount();

    // Reload: nothing in memory survives — new router, new cache.
    renderPerformance('/repos/7/performance?finding=2');
    const detail = await screen.findByTestId('finding-detail');
    expect(detail).toHaveTextContent(FIXTURE.evidence);
    expect(detail).toHaveTextContent(FIXTURE.recommendation);
    expect(screen.getByTestId('finding-open-2')).toHaveAttribute('aria-expanded', 'true');
  });

  it('a stale ?finding= id says so rather than showing nothing', async () => {
    renderPerformance('/repos/7/performance?finding=999');
    expect(await screen.findByTestId('performance-finding-missing')).toHaveTextContent(
      /No performance finding with that id/,
    );
  });

  it('names the source rule and links delivery metrics out to Activity', async () => {
    renderPerformance('/repos/7/performance?window=90d');
    expect(await screen.findByTestId('finding-2')).toHaveTextContent('bpm-perf-query-in-loop');
    expect(screen.getByTestId('performance-to-activity')).toHaveAttribute(
      'href',
      expect.stringMatching(/\/repos\/7\/activity\?.*window=90d/),
    );
  });
});

describe('Performance tab — no provider is not the same screen as a clean run', () => {
  it('zero findings after a SUCCESSFUL run is a result', async () => {
    items = [];
    renderPerformance();
    const empty = await screen.findByText(/No open performance findings/);
    expect(empty).toHaveTextContent(/a result, not an absence of measurement/);
    const coverage = screen.getByTestId('performance-coverage');
    expect(coverage).toHaveAttribute('data-state', 'measured');
    expect(coverage).toHaveTextContent(/Last reviewed .* by performance at commit 3308dbe00000/);
  });

  it('zero findings with NO provider is an absence of measurement', async () => {
    items = [];
    caps = capabilities([METADATA, AI_OFF]);
    renderPerformance();
    const coverage = await screen.findByTestId('performance-coverage');
    expect(coverage).toHaveAttribute('data-state', 'no_provider');
    expect(coverage).toHaveTextContent(/No performance reviewer is set up/);
    expect(coverage).toHaveTextContent(/not a clean bill of health/);
    expect(screen.queryByText(/a result, not an absence/)).toBeNull();
    // The findings panel's empty sentence agrees with the coverage line —
    // one producer, one story.
    expect(screen.getByTestId('performance-findings')).toHaveTextContent(
      /No performance reviewer is set up/,
    );
  });

  it('a failed run with no earlier success is neither', async () => {
    items = [];
    caps = capabilities([
      METADATA,
      cap({ state: 'failed', last_success_at: null, last_success_ref: null }),
      AI_OFF,
    ]);
    renderPerformance();
    const coverage = await screen.findByTestId('performance-coverage');
    expect(coverage).toHaveAttribute('data-state', 'failed');
    expect(coverage).toHaveTextContent(/failed and no earlier one finished/);
  });

  it('a later failure does not erase the run that found the fixture', async () => {
    caps = capabilities([METADATA, cap({ state: 'failed' }), AI_OFF]);
    renderPerformance();
    const coverage = await screen.findByTestId('performance-coverage');
    expect(coverage).toHaveAttribute('data-state', 'measured');
    expect(coverage).toHaveTextContent(/A later attempt failed/);
    expect(await screen.findByTestId('finding-2')).toBeInTheDocument();
  });
});

describe('Performance tab — nothing here was timed, and nothing here runs code', () => {
  it('prints no runtime number in any state', async () => {
    for (const rows of [
      [METADATA, cap({}), AI_OFF],
      [METADATA, AI_OFF],
      [METADATA, cap({ state: 'running', last_success_at: null }), AI_OFF],
    ]) {
      caps = capabilities(rows);
      const view = renderPerformance('/repos/7/performance?finding=2');
      const page = await screen.findByTestId('performance-review');
      await screen.findByTestId('performance-coverage');
      const disclaimer = screen.getByTestId('performance-disclaimer');
      expect(disclaimer).toHaveTextContent(/code-review suggestions/);
      const text = page.textContent ?? '';
      expect(text).not.toMatch(RUNTIME_NUMBER);
      expect(text).not.toMatch(RUNTIME_CLAIM);
      // The only place the runtime words may appear is the sentence saying
      // they are NOT here.
      expect(text.replace(disclaimer.textContent ?? '', '')).not.toMatch(RUNTIME_WORDS);
      view.unmount();
    }
  });

  it('reads only our own API: capabilities and findings, never a forge or an archive', async () => {
    renderPerformance('/repos/7/performance?finding=2');
    await screen.findByTestId('finding-detail');
    for (const url of requests) {
      // rules/precision (W18-22): the drawer's rule record, also our own DB.
      expect(url).toMatch(
        /\/api\/v1\/(repos\/7\/capabilities|findings|rules\/precision|me\/context)/,
      );
      expect(url).not.toMatch(/tarball|archive|clone|raw|exec|run/);
    }
  });

  it('the page source has no way to execute customer code', () => {
    // import.meta.url is not a file URL under jsdom, and vitest runs from
    // apps/web on its own and from the repo root under `pnpm test`.
    const here = [process.cwd(), path.join(process.cwd(), 'apps/web')]
      .map((root) => path.resolve(root, 'src/widgets/findings'))
      .find((dir) => existsSync(path.join(dir, 'performance.ts')))!;
    const sources = [
      `${here}/PerformanceReview.tsx`,
      `${here}/performance.ts`,
      `${here}/../../routes/repos/$repoId/performance.tsx`,
    ].map((p) => readFileSync(p, 'utf8'));
    for (const src of sources) {
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new\s+Function\s*\(/);
      expect(src).not.toMatch(/new\s+Worker\s*\(/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/<script|<iframe|srcdoc/i);
      expect(src).not.toMatch(/WebAssembly/);
    }
    // Evidence renders as text through the shared detail panel, never as markup.
    expect(sources[0]).toMatch(/FindingDetail/);
  });
});
