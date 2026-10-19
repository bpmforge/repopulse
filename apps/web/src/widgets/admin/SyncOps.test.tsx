import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_POLL_MS, SyncOps, syncPollInterval } from './SyncOps.js';
import type { OrgSyncStatus, RepoSyncStatus } from './contracts.js';

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
    expect(within(row).getByText('—')).toBeInTheDocument();
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
