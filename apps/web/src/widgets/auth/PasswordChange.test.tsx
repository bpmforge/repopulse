import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { PasswordChange } from './PasswordChange.js';
import { SignedOut } from './SignedOut.js';

// The bootstrap admin's first minute with the product. Getting this wrong does
// not degrade the experience — it locks the first person out of a new install,
// because the session they hold is rejected by every other route by design.

const requests: { url: string; init: RequestInit | undefined }[] = [];
let pendingPasswordChange = true;
let changeAnswer: { status: number; body: unknown };

beforeEach(() => {
  requests.length = 0;
  pendingPasswordChange = true;
  changeAnswer = { status: 200, body: { user: { id: 1 } } };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const answer = url.includes('/auth/local/session')
        ? { status: 200, body: { pending_password_change: pendingPasswordChange } }
        : url.includes('/auth/providers')
          ? { status: 200, body: { local: true, oidc: null, github: false } }
          : changeAnswer;
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  render(<QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>);
}

async function fillAndSubmit(current: string, next: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByTestId('password-current'), current);
  await user.type(screen.getByTestId('password-new'), next);
  await user.type(screen.getByTestId('password-confirm'), confirm);
  await user.click(screen.getByTestId('password-submit'));
}

describe('SignedOut routing (W15-04)', () => {
  it('sends a session pending a password change to the change screen, not the form', async () => {
    renderWith(<SignedOut expired={false} />);
    expect(await screen.findByTestId('password-change')).toBeInTheDocument();
    // The sign-in form would reject the password this person was given — they
    // already used it.
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  });

  it('sends a genuinely signed-out visitor to sign-in', async () => {
    pendingPasswordChange = false;
    renderWith(<SignedOut expired={false} />);
    expect(await screen.findByTestId('signin')).toBeInTheDocument();
    expect(screen.queryByTestId('password-change')).not.toBeInTheDocument();
  });

  it('shows neither screen while the question is still open', () => {
    renderWith(<SignedOut expired={false} />);
    expect(screen.getByTestId('signin-probe')).toBeInTheDocument();
    expect(screen.queryByTestId('signin')).not.toBeInTheDocument();
  });
});

describe('PasswordChange (W15-04)', () => {
  it('posts the change to /auth/local/password', async () => {
    renderWith(<PasswordChange />);
    await fillAndSubmit('bootstrap passphrase', 'a password of my own', 'a password of my own');

    await waitFor(() => {
      const post = requests.find((r) => r.url === '/auth/local/password');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init?.body))).toEqual({
        current_password: 'bootstrap passphrase',
        new_password: 'a password of my own',
      });
    });
  });

  it('refuses a mismatched confirmation without asking the server', async () => {
    renderWith(<PasswordChange />);
    await fillAndSubmit('bootstrap passphrase', 'a password of my own', 'a different one entirely');

    await waitFor(() =>
      expect(screen.getByTestId('password-change-error')).toHaveTextContent(/do not match/i),
    );
    expect(requests.some((r) => r.url === '/auth/local/password')).toBe(false);
  });

  it('states the length rule before the server has to', async () => {
    renderWith(<PasswordChange />);
    await fillAndSubmit('bootstrap passphrase', 'short', 'short');
    await waitFor(() =>
      expect(screen.getByTestId('password-change-error')).toHaveTextContent(/at least 12/i),
    );
    expect(requests.some((r) => r.url === '/auth/local/password')).toBe(false);
  });

  it('surfaces the API’s refusal — a wrong current password is actionable', async () => {
    changeAnswer = { status: 401, body: { title: 'Current password is incorrect', status: 401 } };
    renderWith(<PasswordChange />);
    await fillAndSubmit('not the bootstrap one', 'a password of my own', 'a password of my own');
    await waitFor(() =>
      expect(screen.getByTestId('password-change-error')).toHaveTextContent(
        'Current password is incorrect',
      ),
    );
  });

  it('offers a way out: a pending session can log itself out of /auth/local/logout', async () => {
    const user = userEvent.setup();
    renderWith(<PasswordChange />);
    await user.click(await screen.findByTestId('password-change-abandon'));
    // NOT /auth/logout, which ignores a session without a `userId`.
    await waitFor(() => expect(requests.some((r) => r.url === '/auth/local/logout')).toBe(true));
  });

  it('labels all three fields and marks the new ones as new-password', async () => {
    renderWith(<PasswordChange />);
    await screen.findByTestId('password-current');
    expect(screen.getByLabelText('Current password')).toBe(screen.getByTestId('password-current'));
    expect(screen.getByLabelText('New password')).toBe(screen.getByTestId('password-new'));
    expect(screen.getByLabelText('Repeat new password')).toBe(
      screen.getByTestId('password-confirm'),
    );
    // Password managers offer to generate and store one only on this hint.
    expect(screen.getByTestId('password-new')).toHaveAttribute('autocomplete', 'new-password');
  });
});
