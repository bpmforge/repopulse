import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Toaster } from '../../components/shell/Toaster.js';
import { useUiStore } from '../../components/store/uiStore.js';
import { Members } from './Members.js';

// W20-04 (UX_TODO ADM-11, ADM-12). Role changes applied on one click, an admin
// could demote themselves without a word, and when the API refused, the toast
// carried the title alone — "Cannot remove the last admin" without the
// sentence that says what to do about it.

const MEMBERS = {
  items: [
    { user_id: 1, login: 'ada', role: 'admin', joined_at: '2026-01-01T00:00:00Z' },
    { user_id: 2, login: 'bo', role: 'member', joined_at: '2026-01-02T00:00:00Z' },
  ],
};

let patchResponse: { status: number; body: unknown };
const calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls.length = 0;
  useUiStore.setState({ toasts: [] });
  patchResponse = { status: 200, body: { user_id: 1, role: 'member' } };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const { status, body } =
        method === 'PATCH'
          ? patchResponse
          : url.includes('/me/context')
            ? { status: 200, body: { role: 'admin', user_id: 1, workspace: { id: 1 } } }
            : { status: 200, body: MEMBERS };
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

function renderMembers() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Members />
      <Toaster />
    </QueryClientProvider>,
  );
}

describe('Members role changes (W20-04)', () => {
  it('asks before changing a role, and Cancel sends nothing', async () => {
    const user = userEvent.setup();
    renderMembers();
    await user.click(await screen.findByTestId('member-role-2'));
    expect(screen.getByTestId('member-role-consequence-2')).toHaveTextContent(
      /able to change connections/i,
    );
    await user.click(screen.getByTestId('member-role-cancel-2'));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(screen.getByTestId('member-role-2')).toBeInTheDocument();
  });

  it('warns an admin that demoting THEMSELVES loses Settings', async () => {
    const user = userEvent.setup();
    renderMembers();
    // Wait for /me/context so the row knows it is "you".
    await waitFor(() => expect(calls.some((c) => c.url.includes('/me/context'))).toBe(true));
    await user.click(await screen.findByTestId('member-role-1'));
    await waitFor(() =>
      expect(screen.getByTestId('member-role-consequence-1')).toHaveTextContent(
        /You will lose access to Settings/,
      ),
    );
    // Someone else's demotion does not say "you".
    await user.click(screen.getByTestId('member-role-2'));
    expect(screen.getByTestId('member-role-consequence-2')).not.toHaveTextContent(/You will/);
  });

  it('a refused change toasts title, detail and request id, as an alert that stays', async () => {
    const user = userEvent.setup();
    patchResponse = {
      status: 409,
      body: {
        type: 'about:blank',
        title: 'Cannot remove the last admin',
        status: 409,
        detail: 'Promote another member to admin first, then change this one.',
        request_id: 'req-42',
      },
    };
    renderMembers();
    await user.click(await screen.findByTestId('member-role-1'));
    await user.click(screen.getByTestId('member-role-do-1'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot remove the last admin');
    expect(within(alert).getByTestId('toast-detail')).toHaveTextContent(/Promote another member/);
    expect(within(alert).getByTestId('toast-request-id')).toHaveTextContent('req-42');
    // The confirm step stays open so the person can cancel or retry.
    expect(screen.getByTestId('member-role-confirm-1')).toBeInTheDocument();
  });
});
