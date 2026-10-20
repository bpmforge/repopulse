import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_POLL_MS,
  SyncOps,
  syncEmptyMessage,
  connectionLabel,
  phaseCounts,
  sortProblemsFirst,
  syncPollInterval,
} from './SyncOps.js';
import { phaseLabel, type OrgSyncStatus, type RepoSyncStatus } from './contracts.js';

// W17-39 (R-16): a feature switched off on the repository (issues disabled on
// a Gitea repo) is information, not a failure. Before this it could only reach
// the operator as "issues not ingested — HTTP 404" in the red Last error column.

vi.mock('./DlqPanel.js', () => ({ DlqPanel: () => null }));

function repo(over: Partial<RepoSyncStatus>): RepoSyncStatus {
  return {
    repoId: '1',
    repoName: 'acme/widget',
    phase: 'live',
    percentComplete: 50,
    entities: {},
    budget: { remaining: 0, limit: 0, resetAt: null, spent24h: 0 },
    lagSeconds: 60,
    lastError: null,
    lastSyncedAt: null,
    ...over,
  };
}

function respond(body: OrgSyncStatus): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <SyncOps />
    </QueryClientProvider>,
  );
}

describe('SyncOps — features not enabled on a repo (W17-39)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says "not enabled on this repo" for a disabled feature, outside the error column', async () => {
    respond({
      phase: 'live',
      repoCount: 1,
      percentComplete: 50,
      worstLagSeconds: 60,
      repos: [
        repo({
          entities: {
            issues: { cursorAt: null, done: true, error: null, notEnabled: true },
            prs: { cursorAt: null, done: true, error: null, notEnabled: false },
          },
        }),
      ],
    });
    renderWidget();
    const note = await waitFor(() => screen.getByTestId('sync-not-enabled-1'));
    expect(note).toHaveTextContent('issues not enabled on this repo');
    expect(note).not.toHaveTextContent('pull requests');
    // Not styled or placed as a failure.
    expect(note.className).not.toMatch(/text-crit/);
    const row = note.closest('tr')!;
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  });
});

// W20-14 (UX_TODO INS-30, INS-31, INS-32, INS-44, ADM-16, ADM-41).
describe('SyncOps plain words and per-row actions (W20-14)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('names phases in words, shows the last webhook, hides an unrecorded budget, offers Retry and expands a long error', async () => {
    const long = `issues not ingested — HTTP 403: ${'x'.repeat(120)} THE END`;
    respond({
      phase: 'paused_budget',
      repoCount: 2,
      percentComplete: 50,
      worstLagSeconds: 60,
      repos: [
        repo({ repoId: '1', phase: 'paused_budget', lastWebhookAt: new Date().toISOString() }),
        repo({
          repoId: '2',
          phase: 'error',
          lastWebhookAt: null,
          lastError: { at: new Date().toISOString(), message: long, jobId: null },
        }),
      ],
    });
    renderWidget();
    expect(await screen.findByText('Waiting for rate limit', { selector: 'span' })).toBeTruthy();
    expect(screen.getByTestId('sync-phase')).toHaveTextContent('Waiting for rate limit');
    expect(screen.getByTestId('sync-webhook-1')).toHaveTextContent('just now');
    expect(screen.getByTestId('sync-webhook-2')).toHaveTextContent('never');
    expect(screen.queryByText('Budget left')).toBeNull();
    expect(screen.getByTestId('sync-retry-2')).toBeInTheDocument();
    expect(screen.queryByTestId('sync-retry-1')).toBeNull();
    const details = screen.getByTestId('sync-error-2');
    expect(details.tagName).toBe('DETAILS');
    expect(details).toHaveTextContent('THE END');
  });

  it('branches the empty message on whether a forge is connected', () => {
    expect(syncEmptyMessage(0)).toMatch(/No forge is connected/);
    expect(syncEmptyMessage(2)).toMatch(/no repositories are selected/);
  });

  it('labels every phase', () => {
    expect(phaseLabel('history')).toBe('Loading history');
    expect(phaseLabel('live')).toBe('Up to date');
    expect(phaseLabel('paused')).toBe('Paused');
  });
});

// W20-04 (UX_TODO INS-11). The page onboarding sends people to — "watch the
// first sync land" — never updated by itself.
describe('SyncOps keeps itself current (W20-04)', () => {
  const status = (...phases: string[]): OrgSyncStatus => ({
    phase: 'history',
    repoCount: phases.length,
    percentComplete: 10,
    worstLagSeconds: null,
    repos: phases.map((phase, i) => repo({ repoId: String(i), phase })),
  });

  it('polls while any repository is still moving, and stops once all have settled', () => {
    expect(syncPollInterval(status('queued'))).toBe(SYNC_POLL_MS);
    expect(syncPollInterval(status('live', 'history'))).toBe(SYNC_POLL_MS);
    expect(syncPollInterval(status('live', 'paused_budget'))).toBe(SYNC_POLL_MS);
    // Waiting on a human, or done: nothing a poll would change.
    expect(syncPollInterval(status('live', 'error', 'paused'))).toBe(false);
    expect(syncPollInterval(status())).toBe(false);
    expect(syncPollInterval(undefined)).toBe(false);
  });
});

// W20-15 (UX_TODO X-18): at 500 repositories across three connections, the
// admin needs the failing ones first, a count per phase, and which connection.
describe('SyncOps at scale (W20-15, UX_TODO X-18)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const rows = [
    repo({ repoId: '1', repoName: 'acme/a', phase: 'live' }),
    repo({
      repoId: '2',
      repoName: 'acme/b',
      phase: 'error',
      connection: { id: 4, provider: 'gitea', host: 'git.corp.example' },
    }),
    repo({ repoId: '3', repoName: 'acme/c', phase: 'live' }),
  ];

  it('sorts problem phases first and counts each phase', () => {
    expect(sortProblemsFirst(rows).map((r) => r.repoId)).toEqual(['2', '1', '3']);
    expect(phaseCounts(rows)).toEqual([
      ['error', 1],
      ['live', 2],
    ]);
    expect(connectionLabel({ id: 4, provider: 'gitea', host: 'git.corp.example' })).toBe(
      'gitea · git.corp.example',
    );
    expect(connectionLabel(null)).toBe('connection removed');
  });

  it('a phase count filters the table to that phase', async () => {
    respond({
      phase: 'error',
      repoCount: 3,
      percentComplete: 50,
      worstLagSeconds: 60,
      repos: rows,
    });
    renderWidget();
    const errors = await screen.findByTestId('sync-phase-filter-error');
    expect(errors).toHaveTextContent('1 error');
    const table = screen.getByTestId('sync-repo-table');
    expect(within(table).getByText('gitea · git.corp.example')).toBeInTheDocument();
    errors.click();
    await waitFor(() => expect(within(table).queryByText('acme/a')).toBeNull());
    expect(within(table).getByText('acme/b')).toBeInTheDocument();
  });
});
