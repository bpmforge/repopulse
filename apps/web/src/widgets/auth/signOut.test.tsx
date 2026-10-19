import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { UserMenu } from '../../components/shell/UserMenu.js';
import { signOutAndReload } from './contracts.js';

// Sign out exists (W20-01, UX_TODO ADM-02). Before this the user menu held only
// the persona picker and there was no way to end a session from the app.

const requests: { url: string; init: RequestInit | undefined }[] = [];
let status = 204;

beforeEach(() => {
  requests.length = 0;
  status = 204;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify({ status, title: 'Boom' }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('sign out (W20-01)', () => {
  it('posts /auth/logout with the CSRF header, then goes to /', async () => {
    const go = vi.fn();
    await signOutAndReload(go);
    const post = requests.find((r) => r.url === '/auth/logout');
    expect(post?.init?.method).toBe('POST');
    expect((post?.init?.headers as Record<string, string>)['x-requested-with']).toBe('repopulse');
    expect(go).toHaveBeenCalledWith('/');
  });

  it('still leaves the app when the request fails, so nobody is stuck signed in', async () => {
    status = 500;
    const go = vi.fn();
    await signOutAndReload(go);
    expect(go).toHaveBeenCalledWith('/');
  });

  it('is in the user menu', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <UserMenu />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('user-menu'));
    expect(screen.getByTestId('user-menu-signout').textContent).toMatch(/Sign out/);
  });
});
