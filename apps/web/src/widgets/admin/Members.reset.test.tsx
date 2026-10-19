import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Members } from './Members.js';

// W20-07 (UX_TODO INS-03): no way back from a forgotten password.

const MEMBERS = {
  items: [
    {
      user_id: 1,
      login: 'ada',
      role: 'admin',
      auth_provider: 'local',
      joined_at: '2026-01-01T00:00:00Z',
    },
    {
      user_id: 2,
      login: 'bo',
      role: 'member',
      auth_provider: 'oidc',
      joined_at: '2026-01-02T00:00:00Z',
    },
  ],
};
// Assembled at runtime, never a whole literal (CLAUDE.md law 9).
const TEMP = ['tmp', 'pw', 'once'].join('-');
const posts: string[] = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST') posts.push(url);
      const body =
        method === 'POST'
          ? { user_id: 1, login: 'ada', temporary_password: TEMP, must_change_password: true }
          : url.includes('/me/context')
            ? { role: 'admin', user_id: 1, workspace: { id: 1 } }
            : MEMBERS;
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

describe('Members — reset password (W20-07)', () => {
  it('confirms, then shows the one-time password once, and Done drops it', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Members />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByTestId('member-reset-1'));
    expect(posts).toEqual([]);
    await user.click(screen.getByTestId('member-reset-do-1'));
    expect(await screen.findByTestId('member-reset-password-1')).toHaveTextContent(TEMP);
    expect(posts).toEqual(['/api/v1/admin/members/1/reset-password']);

    await user.click(screen.getByText('Done'));
    await waitFor(() => expect(screen.queryByText(TEMP)).toBeNull());
  });

  it('offers no reset for an SSO member, and says why', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Members />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('signs in with SSO')).toBeInTheDocument();
    expect(screen.queryByTestId('member-reset-2')).toBeNull();
  });
});
