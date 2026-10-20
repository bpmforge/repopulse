import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { removeConsequenceText } from './Members.js';
import { PurgeButton, purgedMessage } from './SyncOps.js';
import { scheduledSyncMessage } from './Connections.js';
import { CreateUser, inviteMessage } from '../auth/CreateUser.js';
import { Agreements } from '../agreements/Agreements.js';

// W20-19 (UX_TODO INS-09, INS-62, INS-69, ADM-15, ADM-48/49; decisions
// 2026-10-20): the admin-side pieces of the install and admin decisions.

const requests: { method: string; url: string; body: unknown }[] = [];
let respond: (method: string, url: string) => unknown = () => ({});

beforeEach(() => {
  requests.length = 0;
  respond = () => ({});
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(
        new Response(JSON.stringify(respond(method, url)), {
          status: method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function wrap(node: React.ReactNode) {
  render(<QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>);
}

describe('removing a member (ADM-48/49)', () => {
  it('says the CI tokens are revoked and what stays with the workspace', () => {
    const text = removeConsequenceText({
      ci_tokens: 2,
      shared_views: 1,
      private_views: 3,
      connections: 1,
    });
    expect(text).toMatch(/2 CI tokens they created are revoked/);
    expect(text).toMatch(/1 forge connection they added stays with the workspace/);
    expect(text).toMatch(/1 shared view stays with the workspace and moves to you/);
    expect(
      removeConsequenceText({ ci_tokens: 0, shared_views: 0, private_views: 0, connections: 0 }),
    ).toMatch(/no active CI tokens/);
    // Before the counts arrive it still states the rule.
    expect(removeConsequenceText(undefined)).toMatch(
      /CI tokens are revoked.*stay with the workspace/,
    );
  });
});

describe('removing a repository and its history (INS-09)', () => {
  const row = {
    repoId: '7',
    repoName: 'acme/api',
    phase: 'live',
    percentComplete: 100,
    entities: {},
    budget: { remaining: 0, limit: 0, resetAt: null, spent24h: 0 },
    lagSeconds: null,
    lastError: null,
    lastSyncedAt: null,
  } as never;

  it('stays disabled until the exact org/name is typed, then sends it', async () => {
    respond = (method) =>
      method === 'DELETE'
        ? {
            repo_id: 7,
            repo: 'acme/api',
            purged: true,
            deleted: { repos: 1, pull_requests: 4 },
            narrowed: {},
            ci_tokens_revoked: 0,
            webhooks_removed: 1,
            webhook_failures: [],
          }
        : {};
    const user = userEvent.setup();
    wrap(<PurgeButton row={row} />);
    await user.click(screen.getByTestId('sync-purge-7'));
    expect(screen.getByTestId('sync-purge-confirm-7')).toHaveTextContent(/use Pause instead/);
    const go = screen.getByTestId('sync-purge-do-7');
    await user.type(screen.getByTestId('sync-purge-input-7'), 'acme/ap');
    expect(go).toBeDisabled();
    await user.type(screen.getByTestId('sync-purge-input-7'), 'i');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'DELETE')).toEqual({
        method: 'DELETE',
        url: '/api/v1/repos/7',
        body: { confirm: 'acme/api' },
      }),
    );
  });

  it('summarises a purge, and a webhook that could not be removed', () => {
    expect(
      purgedMessage({
        repo: 'acme/api',
        deleted: { repos: 1, commits: 1 },
        ci_tokens_revoked: 1,
        webhooks_removed: 0,
        webhook_failures: [{ repo: 'acme/api', error: 'HTTP 404' }],
      }),
    ).toBe(
      'acme/api removed and 1 stored record deleted; 1 CI token for it alone revoked; its webhook could not be removed (HTTP 404); delete it in the forge.',
    );
  });
});

describe('scheduled sync only (INS-69)', () => {
  it('says how many webhooks went and how updates arrive', () => {
    expect(
      scheduledSyncMessage({
        scheduled_sync_only: true,
        webhooks_removed: 3,
        webhooks_registered: 0,
        webhook_failures: [],
      }),
    ).toMatch(/^Scheduled sync only: 3 webhooks removed\. .*nightly sync\.$/);
  });
});

describe('creating an account (INS-62)', () => {
  it('sends the chosen role and offers an invite without the password', async () => {
    respond = () => ({
      user: { id: 4, login: 'dana', email: 'dana@example.com' },
      temporary_password: 'not-a-real-one-time-value',
      role: 'admin',
      sign_in_url: 'https://repopulse.example/',
    });
    const user = userEvent.setup();
    wrap(<CreateUser />);
    await user.type(screen.getByTestId('create-user-email'), 'dana@example.com');
    await user.selectOptions(screen.getByTestId('create-user-role'), 'admin');
    await user.click(screen.getByTestId('create-user-submit'));

    const invite = await screen.findByTestId('create-user-invite-text');
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      email: 'dana@example.com',
      role: 'admin',
    });
    const text = (invite as HTMLTextAreaElement).value || invite.textContent || '';
    expect(text).toContain('https://repopulse.example/');
    expect(text).toContain('dana@example.com');
    expect(text).not.toContain('not-a-real-one-time-value');
    // Shown once, apart from the message.
    expect(screen.getByTestId('create-user-temp-password')).toHaveTextContent(
      'not-a-real-one-time-value',
    );
  });

  it('falls back to this address when the API sends no sign-in URL', () => {
    const text = inviteMessage(
      { user: { id: 1, login: 'sam', email: null } } as never,
      'https://rp.example.com/',
    );
    expect(text).toContain('Sign in at https://rp.example.com/ with sam.');
    expect(text).toMatch(/password separately/);
  });
});

describe('working agreements for members (ADM-15)', () => {
  it('lists them with no edit, pause or delete control', async () => {
    respond = (_m, url) =>
      url.includes('/agreements')
        ? {
            items: [
              {
                id: 5,
                kind: 'pr_size_max',
                threshold: { lines: 400 },
                active: true,
                window_days: 30,
                exception_count: 0,
                exceptions: [],
              },
            ],
          }
        : {};
    wrap(<Agreements readOnly />);
    expect(await screen.findByTestId('agreement-5')).toHaveTextContent(/no exceptions/);
    expect(screen.getByTestId('agreement-list-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('agreement-form')).toBeNull();
    expect(screen.queryByTestId('agreement-edit-5')).toBeNull();
    expect(screen.queryByTestId('agreement-delete-5')).toBeNull();
  });
});
