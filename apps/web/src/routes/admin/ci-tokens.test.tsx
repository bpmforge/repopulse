import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { CiTokens, type CiTokenRow } from './ci-tokens.js';
import { CiPullSetup, ciSnippet } from '../../widgets/repo/CiPullSetup.js';

// Settings → CI tokens (W20-08, UX_TODO FND-17): mint with a repository scope
// and expiry, see the secret once, list by prefix, revoke.

const requests: { url: string; init: RequestInit | undefined }[] = [];
let rows: CiTokenRow[];

const row: CiTokenRow = {
  id: 3,
  name: 'payments-api CI',
  prefix: 'rpci_AbCd1234',
  scope: 'pr_findings:read',
  repo_ids: [7],
  created_by: 'alice',
  created_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2027-03-30T00:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  requests.length = 0;
  rows = [row];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/repos'))
        return json({ items: [{ id: 7, org: 'acme', name: 'payments' }] });
      if (init?.method === 'POST')
        return json(
          {
            id: 4,
            name: 'web CI',
            token: 'rpci_SECRET_once',
            prefix: 'rpci_Secr',
            repo_ids: [7],
            expires_at: '2027-01-17T00:00:00.000Z',
          },
          201,
        );
      if (init?.method === 'DELETE') return json({ id: 3, revoked: true });
      return json({ items: rows });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CiTokens />
    </QueryClientProvider>,
  );
}

describe('CI tokens (W20-08)', () => {
  it('lists tokens by prefix with their repositories and last use, never a secret', async () => {
    renderPage();
    const tr = await screen.findByTestId('ci-token-row-3');
    await waitFor(() => expect(tr.textContent).toContain('acme/payments'));
    expect(tr.textContent).toContain('rpci_AbCd1234');
    expect(tr.textContent).toContain('never');
  });

  it('highlights a token that expires within two weeks (W20-15, X-19)', async () => {
    rows = [
      { ...row, id: 8, expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    renderPage();
    expect(await screen.findByTestId('ci-token-due-8')).toHaveTextContent('(expires in 3 days)');
    expect(screen.queryByTestId('ci-token-due-3')).toBeNull();
  });

  it('creates a token for the ticked repositories and shows the secret once', async () => {
    renderPage();
    const submit = await screen.findByTestId('ci-token-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: ' web CI ' } });
    fireEvent.click(await screen.findByTestId('ci-token-repo-7'));
    fireEvent.change(screen.getByTestId('ci-token-days'), { target: { value: '90' } });
    fireEvent.click(submit);
    expect(await screen.findByTestId('ci-token-secret')).toHaveTextContent('rpci_SECRET_once');
    const post = requests.find((r) => r.init?.method === 'POST');
    expect(post?.url).toBe('/api/v1/admin/ci-tokens');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: 'web CI',
      repo_ids: [7],
      expires_in_days: 90,
    });
    fireEvent.click(screen.getByTestId('ci-token-dismiss'));
    expect(screen.queryByTestId('ci-token-secret')).toBeNull();
  });

  it('refuses an expiry past a year before asking the server', async () => {
    renderPage();
    fireEvent.change(await screen.findByTestId('ci-token-name'), { target: { value: 'x' } });
    fireEvent.click(await screen.findByTestId('ci-token-repo-7'));
    fireEvent.change(screen.getByTestId('ci-token-days'), { target: { value: '400' } });
    expect(screen.getByTestId('ci-token-submit')).toBeDisabled();
  });

  it('revokes only after a second press, at the token’s own URL', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('ci-token-revoke-3'));
    expect(requests.some((r) => r.init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('ci-token-revoke-yes-3'));
    await waitFor(() => {
      const del = requests.find((r) => r.init?.method === 'DELETE');
      expect(del?.url).toBe('/api/v1/admin/ci-tokens/3');
    });
  });
});

describe('Repo → CI on-ramp (W20-08)', () => {
  it('links Settings → CI tokens and fills this repository into the CLI step', () => {
    render(<CiPullSetup repoId="7" />);
    expect(screen.getByTestId('ci-pull-tokens-link')).toHaveAttribute('href', '/admin/ci-tokens');
    expect(screen.getByTestId('ci-pull-snippet').textContent).toContain('--repo 7');
    expect(ciSnippet('7', 'https://rp.example')).toContain('REPOPULSE_SERVER=https://rp.example');
  });
});
