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
import { createQueryClient } from '../../../api/queryClient.js';
import { Route as securityRoute } from './security.js';
import type { RepoSecurity, ScannerStatus } from '../../../widgets/security/contracts.js';

// The Security tab, trustworthy (W17-20).
//
// Seven situations must be seven different screens: never run, unavailable,
// rejected request, failed run, running, succeeded with findings, succeeded
// with none. The payloads below are shaped like what the API sends after the
// seeded fixture scan (packages/shared/src/testing/seed) — a real finding id,
// linked to the explorer — and after each of the other outcomes.

const scanner = (over: Partial<ScannerStatus>): ScannerStatus => ({
  key: 'owasp_web',
  display_name: 'OWASP web checklist',
  registered: true,
  enabled: true,
  state: 'never_run',
  last_run_at: null,
  last_run_status: null,
  error: null,
  scanner_version: null,
  validation_funnel: null,
  open_findings: 0,
  ...over,
});

const base = (over: Partial<RepoSecurity> = {}): RepoSecurity => ({
  repo: { id: 7, org: 'acme', name: 'web' },
  open_by_severity: {},
  open_total: 0,
  scanners: [scanner({}), scanner({ key: 'dependency_cve', display_name: 'Dependencies' })],
  top_findings: [],
  secrets: { open: 0, last_stream_scan_at: null, last_history_scan_at: null, verified: 0 },
  cves: [],
  chains: [],
  chains_computed: false,
  validation_funnel: null,
  validation_funnel_recorded: false,
  vex: {
    statements: 0,
    not_affected: 0,
    affected: 0,
    fixed: 0,
    by_justification: {
      component_not_present: 0,
      vulnerable_code_not_present: 0,
      vulnerable_code_not_in_execute_path: 0,
      vulnerable_code_cannot_be_controlled_by_adversary: 0,
      inline_mitigations_already_exist: 0,
    },
  },
  ...over,
});

let security: RepoSecurity;
let me: { role?: string };
const writes: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  security = base();
  me = {};
  writes.length = 0;
  // jsdom has no scrollTo; the router's scroll restoration logs a stack per
  // navigation otherwise, which is noise rather than a failure.
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET') {
        writes.push({ url, method: init.method, body: JSON.parse(String(init.body ?? 'null')) });
      }
      const body = url.includes('/repos/7/security')
        ? security
        : url.includes('/me/context')
          ? me
          : url.includes('/scanners/')
            ? { repo_id: 7, enabled: true }
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

function renderSecurity() {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/security',
    component: securityRoute.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/repos/7/security'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('Security tab — the AI review pass has its own tab', () => {
  // W20-13 (UX_TODO FND-32): the open findings sit directly under Coverage.
  // W24-04: the AI review pass moved to its own tab; one line here says where.
  it('keeps findings under coverage, and points to the AI review tab instead of holding the pass', async () => {
    renderSecurity();
    await screen.findByTestId('security-coverage');
    const order = Array.from(
      document.querySelectorAll(
        '[data-testid="security-coverage"], [data-testid="security-ai-pass-moved"], [data-testid="security-findings"], [data-testid="security-chains"]',
      ),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'security-coverage',
      'security-findings',
      'security-ai-pass-moved',
      'security-chains',
    ]);
    expect(document.querySelector('[data-testid="ai-pass-panel"]')).toBeNull();
    expect(
      screen.getByTestId('security-ai-pass-moved').querySelector('a')?.getAttribute('href'),
    ).toBe('/repos/7/ai-review');
  });
});

describe('Security tab — a fixture scan that found something', () => {
  it('lists the findings and links each to the explorer by its real id', async () => {
    security = base({
      open_total: 2,
      scanners: [scanner({ state: 'ok', open_findings: 2, last_run_at: '2026-09-10T10:00:00Z' })],
      top_findings: [
        {
          id: 4711,
          title: 'SQL built by string concatenation',
          severity: 5,
          dimension: 'security',
          scanner_key: 'owasp_web',
          file: 'src/payments/charge.ts',
          line: 10,
        },
        {
          id: 4712,
          title: 'Hard-coded credential',
          severity: 4,
          dimension: 'secrets',
          scanner_key: 'secrets',
          file: null,
          line: null,
        },
      ],
    });
    renderSecurity();

    const list = await screen.findByTestId('security-findings-list');
    expect(list).toHaveTextContent('SQL built by string concatenation');
    const link = screen.getByTestId('security-finding-link-4711');
    expect(link).toHaveAttribute('href', expect.stringMatching(/\/findings\?.*finding=4711/));
    expect(screen.getByTestId('security-finding-4711')).toHaveTextContent(
      'src/payments/charge.ts:10',
    );
    // And the coverage row is not "ran clean" over two open findings (W16-49).
    expect(screen.getByTestId('scanner-state-owasp_web')).toHaveTextContent(/findings still open/);
    expect(screen.queryByTestId('security-findings-empty')).toBeNull();
  });

  it('offers the rest when the list is capped', async () => {
    security = base({
      open_total: 14,
      scanners: [scanner({ state: 'ok', open_findings: 14 })],
      top_findings: [
        {
          id: 1,
          title: 'a',
          severity: 5,
          dimension: 'security',
          scanner_key: null,
          file: null,
          line: null,
        },
      ],
    });
    renderSecurity();
    expect(await screen.findByTestId('security-findings-all')).toHaveTextContent(
      'All 14 open findings',
    );
  });
});

describe('Security tab — the empty states are different sentences', () => {
  it('zero findings after a SUCCESSFUL run is a result, and says which scanner earned it', async () => {
    security = base({
      scanners: [
        scanner({ state: 'ok', open_findings: 0, last_run_at: '2026-09-10T10:00:00Z' }),
        scanner({
          key: 'dependency_cve',
          display_name: 'Dependencies',
          state: 'ok',
          open_findings: 0,
          last_run_at: '2026-09-10T10:00:00Z',
        }),
      ],
    });
    renderSecurity();

    const empty = await screen.findByTestId('security-findings-empty');
    expect(empty).toHaveTextContent(/No open security findings/);
    expect(empty).toHaveTextContent('OWASP web checklist, Dependencies');
    expect(empty).not.toHaveTextContent(/absence of measurement/);
    // The scanner table shows a REAL zero for the run that earned it.
    expect(screen.getByTestId('scanner-state-owasp_web')).toHaveTextContent('ran clean');
    // The dependencies panel too: measured, not excused.
    const cves = screen.getByTestId('cves-empty');
    expect(cves).toHaveTextContent(/IS a measurement/);
    expect(cves).not.toHaveTextContent(/not a clean bill/i);
  });

  it('zero findings with NO successful run is an absence of measurement', async () => {
    renderSecurity();
    const empty = await screen.findByTestId('security-findings-empty');
    expect(empty).toHaveTextContent(/absence of measurement, not a clean result/);
    // The dependencies panel keeps the sentence the seeded e2e pins.
    expect(screen.getByTestId('cves-empty')).toHaveTextContent(/not a clean bill of health/i);
    expect(screen.getByTestId('cves-empty')).toHaveTextContent(/never run/i);
  });

  it('a FAILED run is neither clean nor never-run, on both panels', async () => {
    security = base({
      scanners: [
        scanner({
          state: 'error',
          error: 'archive request returned 404',
          last_run_at: '2026-09-10T10:00:00Z',
        }),
        scanner({
          key: 'dependency_cve',
          display_name: 'Dependencies',
          state: 'error',
          error: 'grype exited 1',
          last_run_at: '2026-09-10T10:00:00Z',
        }),
      ],
    });
    renderSecurity();

    expect(await screen.findByTestId('scanner-state-owasp_web')).toHaveTextContent(
      /last run failed/,
    );
    expect(screen.getByTestId('scanner-error-owasp_web')).toHaveTextContent(
      'archive request returned 404',
    );
    expect(screen.getByTestId('security-findings-empty')).toHaveTextContent(
      /absence of measurement/,
    );
    const cves = screen.getByTestId('cves-empty');
    expect(cves).toHaveTextContent(/failed/i);
    expect(cves).toHaveTextContent(/not a clean bill of health/i);
    expect(cves).not.toHaveTextContent(/never run/i);
    // Terminal: the button is available for the retry.
    expect(screen.getByTestId('run-scan-button')).toBeEnabled();
  });

  it('a scanner that is UNAVAILABLE says so, and its tools error names the fix', async () => {
    security = base({
      scanners: [
        scanner({ key: 'iac', display_name: 'IaC', registered: false, state: 'never_run' }),
        scanner({
          key: 'dependency_cve',
          display_name: 'Dependencies',
          registered: false,
          state: 'never_run',
        }),
        scanner({ state: 'error', error: 'spawn podman ENOENT' }),
      ],
    });
    renderSecurity();

    expect(await screen.findByTestId('scanner-row-iac')).toHaveTextContent('not in this build');
    expect(screen.getByTestId('cves-empty')).toHaveTextContent(/not in this build/i);
    expect(screen.getByTestId('scanner-fix-owasp_web')).toHaveTextContent('Containerfile.scan');
  });

  it('a scan in flight locks the button and shows no count — and nothing here says clean', async () => {
    security = base({
      scanners: [
        scanner({ state: 'running', open_findings: 3, last_run_at: '2026-09-10T10:00:00Z' }),
        scanner({ key: 'dependency_cve', display_name: 'Dependencies', state: 'running' }),
      ],
    });
    renderSecurity();

    expect(await screen.findByTestId('scanner-state-owasp_web')).toHaveTextContent(/running now/);
    // Not the previous run's 3, which is not this run's count.
    expect(screen.getByTestId('scanner-row-owasp_web')).toHaveTextContent('—');
    const button = screen.getByTestId('run-scan-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/scan running/i);
    expect(screen.getByTestId('cves-empty')).toHaveTextContent(/running now/i);
  });
});

// W20-03 (UX_TODO FND-04, FND-06).
describe('Security tab — drill-downs and exports', () => {
  it('every link to Findings carries this repository, and the secrets one its dimension', async () => {
    security = base({
      open_total: 3,
      scanners: [scanner({ state: 'ok', open_findings: 3 })],
      top_findings: [
        {
          id: 4711,
          title: 'x',
          severity: 5,
          dimension: 'security',
          scanner_key: null,
          file: null,
          line: null,
        },
      ],
    });
    renderSecurity();
    const secrets = await screen.findByTestId('secrets-drill');
    // W20-20 (DSH-33): the repository's own Findings tab, not the workspace list.
    expect(secrets.getAttribute('href')).toMatch(/^\/repos\/7\/findings\?/);
    expect(secrets.getAttribute('href')).toMatch(/dimension=secrets/);
    expect(screen.getByTestId('security-finding-link-4711').getAttribute('href')).toMatch(
      /^\/repos\/7\/findings\?.*finding=4711/,
    );
    expect(screen.getByTestId('security-findings-all').getAttribute('href')).toBe(
      '/repos/7/findings',
    );
  });

  it('offers the VEX and attribution downloads at the API paths that serve them', async () => {
    renderSecurity();
    await screen.findByTestId('cves-empty');
    expect(await screen.findByTestId('download-vex')).toHaveAttribute(
      'href',
      '/api/v1/repos/7/vex.json',
    );
    expect(screen.getByTestId('download-attribution')).toHaveAttribute(
      'href',
      '/api/v1/repos/7/attribution',
    );
    // No SBOM yet, and the link says so before the click rather than after.
    expect(screen.getByTestId('security-exports')).toHaveTextContent(/has not completed a run/);
  });
});

// W20-08 (UX_TODO FND-56, FND-07).
describe('Security tab — CVE rows and scanner switches (W20-08)', () => {
  it('each vulnerable-dependency row opens its finding', async () => {
    security = base({
      cves: [
        {
          finding_id: 91,
          cve_id: 'CVE-2026-1',
          package: 'lodash@4.17.20',
          severity: 4,
          kev: false,
          scanner_key: 'dependency_cve',
        },
      ] as never,
    });
    renderSecurity();
    const link = await screen.findByTestId('cve-link-91');
    expect(link.getAttribute('href')).toMatch(/finding=91/);
    expect(link).toHaveTextContent('CVE-2026-1');
  });

  it('a member is told before pressing that a scan needs an admin (W20-13, FND-29)', async () => {
    me = { role: 'member' };
    renderSecurity();
    expect(await screen.findByTestId('run-scan-admin-only')).toHaveTextContent(/admin role/);
    expect(screen.getByTestId('run-scan-button')).toBeDisabled();
  });

  it('a member sees no switches', async () => {
    renderSecurity();
    await screen.findByTestId('scanner-status');
    expect(screen.queryByTestId('scanner-toggle-owasp_web')).toBeNull();
  });

  it('an admin turns a scanner on only after reading what it costs', async () => {
    me = { role: 'admin' };
    security = base({
      scanners: [scanner({ key: 'owasp_web', enabled: false, state: 'not_enabled' })],
    });
    renderSecurity();
    fireEvent.click(await screen.findByTestId('scanner-toggle-owasp_web'));
    expect(writes).toHaveLength(0);
    expect(screen.getByTestId('scanner-toggle-confirm-owasp_web')).toHaveTextContent(
      /analysis model/,
    );
    fireEvent.click(screen.getByTestId('scanner-toggle-yes-owasp_web'));
    await waitFor(() =>
      expect(writes[0]).toEqual({
        url: '/api/v1/scanners/owasp_web',
        method: 'PUT',
        body: { repo_id: 7, enabled: true },
      }),
    );
  });
});

describe('Security tab — old AI review pass links', () => {
  // W24-04: a saved "start a pass on this file" link (?ai_path=) or a
  // #ai-review-pass anchor goes on to the AI review tab, file and all.
  it.each([
    ['/repos/7/security?ai_path=src%2Fusers.ts', 'src/users.ts'],
    ['/repos/7/security#ai-review-pass', ''],
  ])('sends %s on to the AI review tab', async (entry, path) => {
    const rootRoute = createRootRoute();
    const sec = createRoute({
      getParentRoute: () => rootRoute,
      path: '/repos/$repoId/security',
      validateSearch: securityRoute.options.validateSearch as never,
      beforeLoad: securityRoute.options.beforeLoad as never,
      component: () => <p>security</p>,
    });
    const ai = createRoute({
      getParentRoute: () => rootRoute,
      path: '/repos/$repoId/ai-review',
      validateSearch: (s: Record<string, unknown>) => s as { ai_path?: string },
      component: function AiStub() {
        const search = ai.useSearch() as { ai_path?: string };
        return <p data-testid="ai-stub">ai review:{search.ai_path ?? ''}</p>;
      },
    });
    const routeTree = rootRoute.addChildren([sec, ai] as never);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [entry] }),
    } as never) as unknown as ReturnType<typeof createRouter>;
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('ai-stub')).toHaveTextContent(`ai review:${path}`);
    expect(router.state.location.pathname).toBe('/repos/7/ai-review');
    expect(router.state.location.hash).toBe('ai-review-pass');
  });
});
