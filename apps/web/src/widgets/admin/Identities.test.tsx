import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Toaster } from '../../components/shell/Toaster.js';
import { useUiStore } from '../../components/store/uiStore.js';
import { Identities, filterIdentities, identityLabel } from './Identities.js';

// W20-04 (UX_TODO ADM-10). A merge applied on one click, the picker closed
// before the request finished, and a refused merge — or a refused bot flag —
// said nothing at all.

function identity(id: number, login: string) {
  return {
    id,
    provider: 'github',
    login,
    display_name: login,
    is_bot: false,
    merged_into_id: null,
    commits: 12,
    prs: 3,
    email_fallback: false,
  };
}

const LIST = { items: [identity(1, 'ada'), identity(2, 'ada-work')] };
const MEMBERS = { items: [{ user_id: 7, login: 'ada@corp', auth_provider: 'oidc' }] };

let writeResponse: { status: number; body: unknown };
const writes: { url: string; body: string }[] = [];

beforeEach(() => {
  writes.length = 0;
  useUiStore.setState({ toasts: [] });
  writeResponse = { status: 200, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push({ url: String(input), body: String(init?.body) });
      const get = String(input).includes('/admin/members') ? MEMBERS : LIST;
      const { status, body } = method === 'GET' ? { status: 200, body: get } : writeResponse;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderIdentities() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Identities />
      <Toaster />
    </QueryClientProvider>,
  );
}

describe('identity merge (W20-04)', () => {
  it('choosing a target asks first and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    renderIdentities();
    await user.click(await screen.findByTestId('identity-merge-2'));
    await user.click(screen.getByTestId('merge-into-1'));

    expect(screen.getByTestId('merge-confirm')).toHaveTextContent(
      /Merge ada-work \(github\) into ada \(github\)\? Its 12 commits and 3 pull requests are re-attributed on every screen/,
    );
    expect(writes).toHaveLength(0);

    await user.click(screen.getByTestId('merge-confirm-do'));
    await waitFor(() => expect(screen.queryByTestId('merge-picker')).not.toBeInTheDocument());
    expect(writes[0]?.url).toContain('/admin/identities/2/merge');
    expect(JSON.parse(writes[0]!.body)).toEqual({ into_id: 1 });
  });

  it('a refused merge keeps the picker open and says why, with the request id', async () => {
    const user = userEvent.setup();
    writeResponse = {
      status: 409,
      body: { title: 'Cannot merge into a merged identity', status: 409, request_id: 'req-9' },
    };
    renderIdentities();
    await user.click(await screen.findByTestId('identity-merge-2'));
    await user.click(screen.getByTestId('merge-into-1'));
    await user.click(screen.getByTestId('merge-confirm-do'));

    expect(await screen.findByTestId('merge-error')).toHaveTextContent(
      /Cannot merge into a merged identity/,
    );
    expect(screen.getByTestId('merge-error-request-id')).toHaveTextContent('req-9');
    expect(screen.getByTestId('merge-picker')).toBeInTheDocument();
  });

  it('a refused bot flag is toasted rather than silently reverting', async () => {
    const user = userEvent.setup();
    writeResponse = {
      status: 400,
      body: { title: 'Invalid body', status: 400, detail: 'is_bot must be a boolean' },
    };
    renderIdentities();
    await user.click(await screen.findByTestId('identity-bot-1'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid body');
    expect(alert).toHaveTextContent('is_bot must be a boolean');
  });
});

// W20-10 (UX_TODO INS-51): an OIDC/local member had no way to be linked to
// the committer they are, so their personal screens stayed empty.
describe('identity link (W20-10)', () => {
  it('links a committer to a member', async () => {
    const user = userEvent.setup();
    renderIdentities();
    const select = await screen.findByTestId('identity-link-1');
    await waitFor(() => expect(screen.getAllByText('ada@corp (oidc)').length).toBeGreaterThan(0));
    await user.selectOptions(select, '7');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.url).toContain('/admin/identities/1/link');
    expect(JSON.parse(writes[0]!.body)).toEqual({ user_id: 7 });
  });

  it('a refused link is toasted with the reason', async () => {
    const user = userEvent.setup();
    writeResponse = {
      status: 409,
      body: { title: 'Another account is already linked to this forge identity', status: 409 },
    };
    renderIdentities();
    await screen.findByTestId('identity-link-1');
    await waitFor(() => expect(screen.getAllByText('ada@corp (oidc)').length).toBeGreaterThan(0));
    await user.selectOptions(screen.getByTestId('identity-link-1'), '7');
    expect(await screen.findByRole('alert')).toHaveTextContent('already linked');
  });
});

// W20-15 (UX_TODO X-17): "alice" on GitHub and "alice" on Gitea looked the
// same, and the list was one unsearchable table of every identity.
describe('identities at scale (W20-15, UX_TODO X-17)', () => {
  const rows = [
    { ...identity(1, 'alice'), provider: 'github' },
    { ...identity(2, 'alice'), provider: 'gitea' },
    { ...identity(3, 'dependabot'), is_bot: true },
  ];

  it('labels every identity with its forge', () => {
    expect(identityLabel(rows[1]!)).toBe('alice (gitea)');
  });

  it('filters by text, forge and bot', () => {
    const f = { query: '', provider: '', bots: 'all' as const };
    expect(filterIdentities(rows, { ...f, query: 'ali' }).map((i) => i.id)).toEqual([1, 2]);
    expect(filterIdentities(rows, { ...f, provider: 'gitea' }).map((i) => i.id)).toEqual([2]);
    expect(filterIdentities(rows, { ...f, bots: 'humans' }).map((i) => i.id)).toEqual([1, 2]);
    expect(filterIdentities(rows, { ...f, bots: 'bots' }).map((i) => i.id)).toEqual([3]);
  });

  it('shows the forge on the row and searches the table', async () => {
    const user = userEvent.setup();
    renderIdentities();
    expect(await screen.findByTestId('identity-provider-1')).toHaveTextContent('github');
    await user.type(screen.getByTestId('identity-search'), 'work');
    await waitFor(() => expect(screen.queryByTestId('identity-1')).toBeNull());
    expect(screen.getByTestId('identity-2')).toBeInTheDocument();
    expect(screen.getByTestId('identity-count')).toHaveTextContent('1 of 2');
  });
});
