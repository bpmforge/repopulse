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
import { createQueryClient } from '../../../api/queryClient.js';
import { complexityEmptyCopy, ruleEmptyCopy, Route as codeHealthRoute } from './code-health.js';
import type { ScannerState } from '../../../widgets/security/contracts.js';

// The Code Health tab, trustworthy (W17-20).
//
// The API used to fold a scan_run that was still RUNNING into "ok", so this
// screen said "✓ ran clean" for the whole of every scan, with the previous
// run's count beside it. The screen now speaks the security tab's vocabulary
// and follows a manual run to its end.

interface ChScanner {
  key: string;
  state: ScannerState;
  last_run_at: string | null;
  error: string | null;
  tool_versions: Record<string, string> | null;
  open_findings: number | null;
}

const scanner = (over: Partial<ChScanner>): ChScanner => ({
  key: 'code_health_tools',
  state: 'never_run',
  last_run_at: null,
  error: null,
  tool_versions: null,
  open_findings: null,
  ...over,
});

const base = (scanners: ChScanner[], over: Record<string, unknown> = {}) => ({
  repo: { id: 7, org: 'acme', name: 'web' },
  series: {},
  scanners,
  worst_complexity: [],
  slop_by_rule: [],
  logging_by_rule: [],
  open_total: 0,
  ...over,
});

let payload: ReturnType<typeof base>;

beforeEach(() => {
  payload = base([scanner({})]);
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url.includes('/repos/7/code-health') ? payload : {};
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

function renderCodeHealth() {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/code-health',
    component: codeHealthRoute.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/repos/7/code-health'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('Code Health tab — scanner states', () => {
  it('a scan in flight is "running now" with a dash, and the button is locked', async () => {
    payload = base([
      scanner({ state: 'running', open_findings: 4, last_run_at: '2026-09-10T10:00:00Z' }),
    ]);
    renderCodeHealth();

    const stateCell = await screen.findByTestId('ch-scanner-state-code_health_tools');
    expect(stateCell).toHaveTextContent(/running now/);
    expect(stateCell).not.toHaveTextContent('✓');
    // The 4 is the previous run's, and this run has no count yet.
    expect(screen.getByTestId('ch-scanner-code_health_tools')).toHaveTextContent('—');
    expect(screen.getByTestId('ch-scanner-code_health_tools')).not.toHaveTextContent('4');
    expect(screen.getByTestId('run-scan-button')).toBeDisabled();
    expect(screen.getByTestId('ch-complexity-empty')).toHaveTextContent(/running now/);
  });

  it('a failed run says so, names the fix for a missing image, and unlocks the retry', async () => {
    payload = base([
      scanner({
        state: 'error',
        error: 'code_health_tools: exit 125',
        last_run_at: '2026-09-10T10:00:00Z',
        open_findings: 0,
      }),
    ]);
    renderCodeHealth();

    expect(await screen.findByTestId('ch-scanner-state-code_health_tools')).toHaveTextContent(
      /last run failed/,
    );
    expect(screen.getByTestId('scanner-fix-code_health_tools')).toHaveTextContent(
      'Containerfile.scan',
    );
    expect(screen.getByTestId('run-scan-button')).toBeEnabled();
    const empty = screen.getByTestId('ch-complexity-empty');
    expect(empty).toHaveTextContent(/failed/);
    expect(empty).toHaveTextContent(/not a measurement of a tidy codebase/i);
    expect(empty).not.toHaveTextContent(/IS a measurement/);
  });

  it('a successful run with nothing over the threshold is the ONE measurement of tidiness', async () => {
    payload = base([
      scanner({ state: 'ok', open_findings: 0, last_run_at: '2026-09-10T10:00:00Z' }),
    ]);
    renderCodeHealth();

    expect(await screen.findByTestId('ch-scanner-state-code_health_tools')).toHaveTextContent(
      'ran clean',
    );
    // A REAL zero: the run earned it.
    expect(screen.getByTestId('ch-scanner-code_health_tools')).toHaveTextContent('0');
    expect(screen.getByTestId('ch-complexity-empty')).toHaveTextContent(/IS a measurement/);
  });

  it('a successful run with findings links each to the explorer by its id', async () => {
    payload = base(
      [scanner({ state: 'ok', open_findings: 1, last_run_at: '2026-09-10T10:00:00Z' })],
      {
        worst_complexity: [
          {
            finding_id: 4713,
            rule_id: 'complexity',
            file: 'src/sync/webhook.ts',
            line: 60,
            severity: 2,
            title: 'Function too complex',
            evidence: 'cc=31',
          },
        ],
        open_total: 1,
      },
    );
    renderCodeHealth();

    const link = await screen.findByTestId('ch-complexity-4713');
    expect(link).toHaveAttribute('href', expect.stringMatching(/\/findings\?.*finding=4713/));
    expect(screen.getByTestId('ch-scanner-state-code_health_tools')).toHaveTextContent(
      /findings still open/,
    );
  });

  it('never run keeps the sentence the e2e pins, and a dash', async () => {
    renderCodeHealth();
    expect(await screen.findByTestId('ch-scanner-state-code_health_tools')).toHaveTextContent(
      /has never run/,
    );
    expect(screen.getByTestId('ch-scanner-code_health_tools')).toHaveTextContent('—');
    expect(screen.getByTestId('ch-complexity-empty')).toHaveTextContent(
      /not a measurement of a tidy codebase/i,
    );
  });
});

describe('complexityEmptyCopy', () => {
  it('every non-measuring state disclaims the measurement; only ok claims it', () => {
    const states: ScannerState[] = [
      'not_enabled',
      'never_run',
      'running',
      'stale',
      'error',
      'partial',
      'nothing_scanned',
      'all_rejected',
    ];
    for (const state of states) {
      expect(complexityEmptyCopy({ state }), state).toMatch(/not a measurement/i);
    }
    expect(complexityEmptyCopy({ state: 'ok' })).toMatch(/IS a measurement/);
    expect(complexityEmptyCopy(undefined)).toMatch(/never run/);
  });
});

// W20-12 (UX_TODO DSH-31/DSH-32).
describe('Code Health units, rule links and honest empties (W20-12)', () => {
  it('prints ratios as percentages and links each rule to filtered findings', async () => {
    payload = base([scanner({ key: 'anti_slop', state: 'ok', open_findings: 3 })], {
      series: { M14: [{ value: 0.05, at: '2026-10-01T00:00:00.000Z' }] },
      slop_by_rule: [{ rule: 'slop.empty-catch', count: 3 }],
    });
    renderCodeHealth();
    expect(await screen.findByTestId('ch-headline-Revert rate')).toHaveTextContent('5%');
    expect(screen.getByTestId('ch-rule-slop.empty-catch')).toHaveAttribute(
      'href',
      '/repos/7/findings?rule_id=slop.empty-catch',
    );
    // The logging scanner never ran: no claim of a clean result.
    expect(screen.getByTestId('ch-logging-rules')).toHaveTextContent(
      'the logging hygiene scanner has never run',
    );
  });

  it('only a successful run claims there are none', () => {
    expect(ruleEmptyCopy('slop', 'anti-slop', { state: 'ok' })).not.toMatch(/not a measurement/);
    for (const state of ['never_run', 'error', 'running', 'not_enabled'] as const) {
      expect(ruleEmptyCopy('slop', 'anti-slop', { state })).toMatch(/not a measurement/);
    }
  });
});
