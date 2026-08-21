import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { SignIn } from './SignIn.js';
import type { AuthProviders } from './contracts.js';

// The defect this screen exists to prevent is a button for a provider nobody
// configured: it leads to a 404, or to a vendor's consent page for an App that
// does not exist, and the person cannot tell whose fault that is.

interface Answer {
  status: number;
  body: unknown;
}

let providersAnswer: Answer;
let loginAnswer: Answer;
const requests: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const answer = url.includes('/auth/providers') ? providersAnswer : loginAnswer;
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function renderSignIn(providers: Partial<AuthProviders> = {}, node?: ReactNode) {
  providersAnswer = {
    status: 200,
    body: { local: true, oidc: null, github: false, ...providers },
  };
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      {node ?? <SignIn expired={false} />}
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  requests.length = 0;
  loginAnswer = { status: 200, body: { must_change_password: false } };
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('SignIn (W15-04)', () => {
  it('renders only the providers this deployment offers', async () => {
    renderSignIn();
    expect(await screen.findByTestId('signin-local')).toBeInTheDocument();
    expect(screen.queryByTestId('signin-github')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signin-oidc')).not.toBeInTheDocument();
  });

  it('shows the GitHub link only when a GitHub App is configured', async () => {
    renderSignIn({ github: true });
    const github = await screen.findByTestId('signin-github');
    // A full-page navigation, not a router link: the round trip ends at GitHub
    // and comes back with a cookie.
    expect(github).toHaveAttribute('href', '/auth/login');
  });

  it('labels the SSO button with the operator’s name for it, not "OIDC"', async () => {
    renderSignIn({ oidc: { display_name: 'Acme SSO' } });
    const sso = await screen.findByTestId('signin-oidc');
    expect(sso).toHaveTextContent('Acme SSO');
    expect(sso).toHaveAttribute('href', '/auth/oidc/login');
  });

  it('falls back to local-only — never to every button — when discovery fails', async () => {
    providersAnswer = { status: 500, body: { title: 'boom', status: 500 } };
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SignIn expired={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('signin-local')).toBeInTheDocument();
    expect(screen.queryByTestId('signin-github')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signin-oidc')).not.toBeInTheDocument();
  });

  it('posts credentials to /auth/local/login with the CSRF header', async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.type(await screen.findByTestId('signin-email'), 'admin@example.com');
    await user.type(screen.getByTestId('signin-password'), 'a good long password');
    await user.click(screen.getByTestId('signin-submit'));

    await waitFor(() => {
      const post = requests.find((r) => r.url === '/auth/local/login');
      expect(post).toBeDefined();
      expect(post!.init?.method).toBe('POST');
      // SC-7: without this header the API 403s every mutating request.
      expect((post!.init?.headers as Record<string, string>)['x-requested-with']).toBe('repopulse');
      expect(JSON.parse(String(post!.init?.body))).toEqual({
        email: 'admin@example.com',
        password: 'a good long password',
      });
    });
  });

  it('states a rejected sign-in in a live region instead of failing silently', async () => {
    const user = userEvent.setup();
    loginAnswer = {
      status: 401,
      body: { title: 'Invalid email or password', status: 401 },
    };
    renderSignIn();
    await user.type(await screen.findByTestId('signin-email'), 'admin@example.com');
    await user.type(screen.getByTestId('signin-password'), 'wrong');
    await user.click(screen.getByTestId('signin-submit'));

    const error = await screen.findByTestId('signin-error');
    await waitFor(() => expect(error).toHaveTextContent('Invalid email or password'));
    // aria-live rather than role="alert": the region is present from first
    // paint (an assertive region inserted at the moment of the error is often
    // not announced), and a permanently mounted role="alert" would make the
    // signed-out screen contain an alert while nothing is wrong — which the
    // shell's own test asserts against, correctly.
    expect(error).toHaveAttribute('aria-live', 'assertive');
  });

  it('says "your session ended" only when there was one', async () => {
    renderSignIn({}, <SignIn expired />);
    expect(await screen.findByTestId('signin')).toHaveTextContent(/session ended/i);
  });

  it('every input has a label, which is what makes the form usable at all', async () => {
    renderSignIn();
    await screen.findByTestId('signin-local');
    // getByLabelText throws when the association is missing, so this IS the
    // assertion — axe checks the same thing on the running page (not run here).
    expect(screen.getByLabelText('Email')).toBe(screen.getByTestId('signin-email'));
    expect(screen.getByLabelText('Password')).toBe(screen.getByTestId('signin-password'));
  });
});
