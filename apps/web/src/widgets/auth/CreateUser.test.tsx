import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { CreateUser } from './CreateUser.js';

// Without this form, "an admin creates the account" meant a curl command.

const requests: { url: string; init: RequestInit | undefined }[] = [];
let answer: { status: number; body: unknown };

beforeEach(() => {
  requests.length = 0;
  answer = {
    status: 201,
    body: {
      user: { id: 4, login: 'dana', email: 'dana@example.com' },
      temporary_password: 'RXhhbXBsZS1PbmNlLU9ubHk',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
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

function renderCreateUser() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CreateUser />
    </QueryClientProvider>,
  );
}

describe('CreateUser (W15-04)', () => {
  it('posts to /auth/local/users and omits an empty optional name', async () => {
    const user = userEvent.setup();
    renderCreateUser();
    await user.type(screen.getByTestId('create-user-email'), 'dana@example.com');
    await user.click(screen.getByTestId('create-user-submit'));

    await waitFor(() => {
      const post = requests.find((r) => r.url === '/auth/local/users');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init?.body))).toEqual({
        email: 'dana@example.com',
        role: 'member',
      });
    });
  });

  it('shows the one-time password and says plainly that it cannot be read again', async () => {
    const user = userEvent.setup();
    renderCreateUser();
    await user.type(screen.getByTestId('create-user-email'), 'dana@example.com');
    await user.click(screen.getByTestId('create-user-submit'));

    const shown = await screen.findByTestId('create-user-temp-password');
    expect(shown).toHaveTextContent('RXhhbXBsZS1PbmNlLU9ubHk');
    // The API stores only a scrypt hash, so an admin who closes this without
    // copying it has to create the account again.
    expect(screen.getByTestId('create-user-result')).toHaveTextContent(/only time it can be read/i);
  });

  it('does not invent a password field when the admin supplied one', async () => {
    answer = { status: 201, body: { user: { id: 5, login: 'sam', email: 'sam@example.com' } } };
    const user = userEvent.setup();
    renderCreateUser();
    await user.type(screen.getByTestId('create-user-email'), 'sam@example.com');
    await user.click(screen.getByTestId('create-user-submit'));

    await screen.findByTestId('create-user-result');
    expect(screen.queryByTestId('create-user-temp-password')).not.toBeInTheDocument();
  });

  it('surfaces the duplicate-address refusal rather than a generic failure', async () => {
    answer = {
      status: 409,
      body: { title: 'An account with that email already exists', status: 409 },
    };
    const user = userEvent.setup();
    renderCreateUser();
    await user.type(screen.getByTestId('create-user-email'), 'dana@example.com');
    await user.click(screen.getByTestId('create-user-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('create-user-error')).toHaveTextContent(/already exists/i),
    );
    expect(screen.queryByTestId('create-user-result')).not.toBeInTheDocument();
  });

  it('labels both fields', () => {
    renderCreateUser();
    expect(screen.getByLabelText(/Email/)).toBe(screen.getByTestId('create-user-email'));
    expect(screen.getByLabelText(/Name/)).toBe(screen.getByTestId('create-user-name'));
  });
});
