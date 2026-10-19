import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { useUiStore } from '../../components/store/uiStore.js';
import {
  Connections,
  OPTIONAL_SCOPES,
  connectErrorSentence,
  removeConsequence,
} from './Connections.js';

// W20-07 (UX_TODO INS-07, INS-08, INS-64, INS-73).

const CONNECTIONS = {
  items: [
    {
      id: 5,
      provider: 'gitea',
      auth_kind: 'pat',
      fingerprint: 'x',
      last4: 'ab12',
      status: 'active',
      repo_count: 3,
      base_url: 'https://git.example.com',
    },
  ],
};

const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body =
        method === 'POST' && url.includes('/webhooks')
          ? {
              url: 'https://new.example/webhooks/gitea',
              repos: 3,
              registered: 2,
              failed: [{ repo: 'acme/c', error: 'forbidden' }],
            }
          : method === 'PATCH'
            ? { id: 5, status: 'active', fingerprint: 'y' }
            : method === 'DELETE'
              ? { id: 5, outcome: 'disconnected', paused_repos: 3 }
              : url.includes('available-repos')
                ? { items: [], total: 0, truncated: false }
                : CONNECTIONS;
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

function renderConnections() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Connections />
    </QueryClientProvider>,
  );
}

describe('connection guidance (W20-07)', () => {
  it('INS-07: the Gitea form names every read scope INSTALL lists, and what the optional ones add', async () => {
    const user = userEvent.setup();
    renderConnections();
    await user.selectOptions(screen.getByTestId('connection-provider'), 'gitea');
    expect(screen.getByLabelText(/Gitea access token/)).toBeInTheDocument();
    expect(
      screen.getByText(/read:repository, read:organization and read:user/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('connection-optional-scopes')).toHaveTextContent(
      /write:repository adds live updates.*read:issue adds issues/,
    );
    expect(OPTIONAL_SCOPES.github).toBeNull();
  });

  it('INS-73: a blank GitLab URL is labelled as gitlab.com, not "the server default"', async () => {
    const user = userEvent.setup();
    renderConnections();
    await user.selectOptions(screen.getByTestId('connection-provider'), 'gitlab');
    expect(screen.getByText(/blank means gitlab\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/server default\)/)).toBeNull();
  });

  it('INS-64: unreachable, TLS and wrong-URL failures never tell the admin to replace the token', () => {
    for (const kind of ['cannot_reach', 'tls_untrusted', 'wrong_url']) {
      const sentence = connectErrorSentence(`Credential validation failed: ${kind}`, 'gitea');
      expect(sentence, kind).not.toBeNull();
      expect(sentence, kind).not.toMatch(/create a new one/);
    }
    expect(connectErrorSentence('Credential validation failed: tls_untrusted', 'gitea')).toMatch(
      /internal-CA certificate/,
    );
  });
});

describe('managing a connection (W20-07, INS-08)', () => {
  it('replaces a token in place and clears the field', async () => {
    const user = userEvent.setup();
    renderConnections();
    await user.click(await screen.findByTestId('connection-rekey-5'));
    const rotated = ['gitea', 'rotated', 'value'].join('-');
    await user.type(screen.getByTestId('connection-rekey-input-5'), rotated);
    await user.click(screen.getByTestId('connection-rekey-do-5'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: '/api/v1/connections/5',
        body: { credential: rotated },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('connection-rekey-form-5')).toBeNull());
  });

  it('says what happens to the tracked repos before removing', async () => {
    const user = userEvent.setup();
    renderConnections();
    await user.click(await screen.findByTestId('connection-remove-5'));
    expect(screen.getByTestId('connection-remove-consequence-5')).toHaveTextContent(
      /3 tracked repositories stop syncing and are paused; history already collected stays/,
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByTestId('connection-remove-do-5'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/connections/5'),
    );
  });

  it('describes an empty connection as deleted outright', () => {
    expect(removeConsequence(0)).toMatch(/deleted outright/);
    expect(removeConsequence(1)).toMatch(/1 tracked repository stops syncing and is paused/);
  });

  // W20-10 (UX_TODO ADM-77): after the install moves, hooks still point at the
  // old address; this button re-registers them and says which ones failed.
  it('re-registers webhooks and names the repositories it could not', async () => {
    useUiStore.setState({ toasts: [] });
    const user = userEvent.setup();
    renderConnections();
    await user.click(await screen.findByTestId('connection-rehook-5'));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.endsWith('/connections/5/webhooks')),
      ).toBeDefined(),
    );
    await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
    const toast = useUiStore.getState().toasts[0]!;
    expect(toast.tone).toBe('warn');
    expect(toast.message).toMatch(/2 of 3; not for acme\/c \(forbidden\)/);
  });
});
