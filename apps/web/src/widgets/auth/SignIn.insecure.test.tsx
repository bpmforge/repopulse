import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { SignIn, insecureSessionWarning } from './SignIn.js';

// W20-07 (UX_TODO INS-01). Over plain http on anything but localhost the
// browser drops the Secure session cookie, so sign-in looped with no error.

function stubProviders(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ local: true, oidc: null, github: false, ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

const secureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (secureContext) Object.defineProperty(window, 'isSecureContext', secureContext);
  else delete (window as { isSecureContext?: boolean }).isSecureContext;
});

describe('sign-in over plain http (W20-07, INS-01)', () => {
  it('warns before the attempt when the cookie is Secure and the page is not a secure context', async () => {
    stubProviders({ secure_cookies: true });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SignIn expired={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('signin-insecure-origin')).toHaveTextContent(
      /only keeps sessions over HTTPS \(or on localhost\)/,
    );
  });

  it('says nothing when cookies are not Secure (a dev stack) or the page is https/localhost', () => {
    expect(insecureSessionWarning(false, false)).toBeNull();
    expect(insecureSessionWarning(true, true)).toBeNull();
    expect(insecureSessionWarning(undefined, false)).toBeNull();
    expect(insecureSessionWarning(true, false)).toMatch(/plain http/);
  });

  it('INS-03: tells a person who forgot their password where the reset is', async () => {
    stubProviders({});
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SignIn expired={false} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/Forgot your password\? Ask them to reset it/),
    ).toBeInTheDocument();
  });
});
