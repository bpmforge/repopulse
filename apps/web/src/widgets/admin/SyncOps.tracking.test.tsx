import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { SyncOps } from './SyncOps.js';

// W20-07 (UX_TODO INS-09): there was no way to stop tracking a repository.

vi.mock('./DlqPanel.js', () => ({ DlqPanel: () => null }));

const repo = (repoId: string, phase: string) => ({
  repoId,
  repoName: `acme/r${repoId}`,
  phase,
  percentComplete: 50,
  entities: {},
  budget: { remaining: 0, limit: 0, resetAt: null, spent24h: 0 },
  lagSeconds: null,
  lastError: null,
  lastSyncedAt: null,
});

const puts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  puts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') puts.push({ url: String(input), body: JSON.parse(String(init!.body)) });
      const body =
        method === 'PUT'
          ? { repo_id: 1, sync_status: 'paused' }
          : {
              phase: 'live',
              repoCount: 2,
              percentComplete: 50,
              worstLagSeconds: null,
              repos: [repo('1', 'live'), repo('2', 'paused')],
            };
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

describe('Sync — pause and resume a repository (W20-07, INS-09)', () => {
  it('pauses a live repo and resumes a paused one', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SyncOps />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('sync-tracking-1')).toHaveTextContent('Pause');
    expect(screen.getByTestId('sync-tracking-2')).toHaveTextContent('Resume');

    await user.click(screen.getByTestId('sync-tracking-1'));
    await user.click(screen.getByTestId('sync-tracking-2'));
    await waitFor(() =>
      expect(puts).toEqual([
        { url: '/api/v1/repos/1/tracking', body: { paused: true } },
        { url: '/api/v1/repos/2/tracking', body: { paused: false } },
      ]),
    );
  });
});
