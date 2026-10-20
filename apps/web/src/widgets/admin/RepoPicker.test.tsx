import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { RepoPicker, matchesFilter, repoCount, trackedLabel } from './RepoPicker.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...rest
  }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// W20-07 (UX_TODO INS-09, INS-10, INS-52).

const AVAILABLE = {
  items: [
    {
      forge_repo_id: '1',
      org: 'acme',
      name: 'alpha',
      is_private: true,
      is_archived: false,
      tracked: true,
      sync_status: 'paused',
    },
    {
      forge_repo_id: '2',
      org: 'acme',
      name: 'beta',
      is_private: true,
      is_archived: false,
      tracked: false,
      sync_status: null,
    },
    {
      forge_repo_id: '3',
      org: 'acme',
      name: 'quiet',
      is_private: true,
      is_archived: false,
      tracked: false,
      sync_status: null,
    },
  ],
  total: 3,
  truncated: false,
};

const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') posts.push(JSON.parse(String(init!.body)));
      const body =
        (init?.method ?? 'GET') === 'POST'
          ? { repo_ids: [10, 11], webhook_failed: ['acme/beta'] }
          : AVAILABLE;
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

function renderPicker() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RepoPicker connectionId={4} connectionsKey={['connections']} />
    </QueryClientProvider>,
  );
}

describe('RepoPicker (W20-07)', () => {
  it('INS-10: shows tracked repos ticked, disabled and with their state', async () => {
    renderPicker();
    const tracked = await screen.findByTestId('repo-option-1');
    expect(tracked).toBeChecked();
    expect(tracked).toBeDisabled();
    expect(screen.getByTestId('repo-tracked-1')).toHaveTextContent('tracked · paused');
    expect(screen.getByTestId('repo-option-2')).not.toBeDisabled();
    expect(trackedLabel('live')).toBe('tracked');
  });

  it('INS-52: says how many repositories the token can see', async () => {
    renderPicker();
    expect(await screen.findByTestId('repo-picker-count')).toHaveTextContent(
      '3 repositories visible to this token · 1 already tracked',
    );
  });

  it('INS-09: offers "track all" for the untracked ones', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByTestId('repo-select-all'));
    await waitFor(() => expect(posts).toEqual([{ all_with_auto_add: true }]));
    expect(screen.getByTestId('repo-select-all')).toHaveTextContent('Track all 2 and auto-add new');
  });
});

describe('RepoPicker (W20-14)', () => {
  it('INS-28 / INS-44: names the forge, counts the selection and writes plural-aware copy', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RepoPicker
          connectionId={4}
          connectionsKey={['connections']}
          sourceLabel="Gitea · git.example.com"
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText('Select repositories to track — Gitea · git.example.com'),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('repo-select-submit')).toHaveTextContent(
      'Tick repositories to track',
    );
    await user.click(screen.getByTestId('repo-option-2'));
    expect(screen.getByTestId('repo-select-submit')).toHaveTextContent('Track 1 repository');
    expect(screen.getByTestId('repo-picker-count')).toHaveTextContent('1 selected');
    expect(repoCount(2)).toBe('2 repositories');
  });

  it('INS-28: the filter matches org/name, case-insensitively', () => {
    expect(matchesFilter({ org: 'Acme', name: 'Payments' }, 'acme/pay')).toBe(true);
    expect(matchesFilter({ org: 'acme', name: 'beta' }, 'zzz')).toBe(false);
    expect(matchesFilter({ org: 'acme', name: 'beta' }, '  ')).toBe(true);
  });

  it('INS-29: success links to Sync, names refused webhooks and clears the selection', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByTestId('repo-option-2'));
    await user.click(screen.getByTestId('repo-select-submit'));
    expect(await screen.findByTestId('repo-select-sync-link')).toHaveAttribute(
      'href',
      '/admin/sync',
    );
    expect(screen.getByTestId('repo-select-webhook-failed')).toHaveTextContent('acme/beta');
    expect(screen.getByTestId('repo-select-result')).toHaveTextContent('2 repositories');
    expect(screen.getByTestId('repo-option-2')).not.toBeChecked();
  });
});
