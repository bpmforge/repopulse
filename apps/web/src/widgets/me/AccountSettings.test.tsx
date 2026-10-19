import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { useUiStore } from '../../components/store/uiStore.js';
import { AccountSettings } from './AccountSettings.js';

// W20-04 (UX_TODO ADM-04). Members clicked "Settings" and met an admin wall;
// theme, home screen, password and sign-out had no page of their own, and a
// voluntary password change had no screen at all.

const writes: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  writes.length = 0;
  useUiStore.setState({ theme: 'dark' });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push({ url, method, body: String(init?.body) });
      const body = url.includes('/me/context')
        ? { role: 'member', persona: 'developer', workspace: { id: 1, slug: 'a', name: 'Acme' } }
        : url.includes('/me/persona')
          ? { persona: 'security', home: '/findings' }
          : { user: { id: 2 } };
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

function renderAccount() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AccountSettings />
    </QueryClientProvider>,
  );
}

describe('Account page (W20-04)', () => {
  it('sets the theme and the home screen', async () => {
    const user = userEvent.setup();
    renderAccount();
    await user.click(screen.getByTestId('account-theme-light'));
    expect(useUiStore.getState().theme).toBe('light');

    await waitFor(() => expect(screen.getByTestId('account-persona-developer')).toBeChecked());
    await user.click(screen.getByTestId('account-persona-security'));
    await waitFor(() =>
      expect(writes.find((w) => w.url.includes('/me/persona'))?.body).toBe(
        JSON.stringify({ persona: 'security' }),
      ),
    );
  });

  it('changes the password voluntarily, says so, and clears the fields', async () => {
    const user = userEvent.setup();
    renderAccount();
    await user.type(screen.getByTestId('password-current'), 'my current password');
    await user.type(screen.getByTestId('password-new'), 'a brand new password');
    await user.type(screen.getByTestId('password-confirm'), 'a brand new password');
    await user.click(screen.getByTestId('password-submit'));

    expect(await screen.findByTestId('password-change-saved')).toHaveTextContent(
      'Password changed',
    );
    expect(writes.some((w) => w.url === '/auth/local/password')).toBe(true);
    expect(screen.getByTestId('password-current')).toHaveValue('');
    // The forced screen's escape hatch has no place on a page you chose to open.
    expect(screen.queryByTestId('password-change-abandon')).toBeNull();
  });

  it('offers sign out', () => {
    renderAccount();
    expect(screen.getByTestId('account-signout')).toHaveTextContent('Sign out');
  });
});
