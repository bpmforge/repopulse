import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Toaster } from '../../components/shell/Toaster.js';
import { useUiStore } from '../../components/store/uiStore.js';
import { Identities } from './Identities.js';

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
      const { status, body } = method === 'GET' ? { status: 200, body: LIST } : writeResponse;
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
      /Merge ada-work into ada\? Its 12 commits and 3 pull requests are re-attributed on every screen/,
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
