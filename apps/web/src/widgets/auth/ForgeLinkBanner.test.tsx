import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { ForgeLinkBanner } from './ForgeLinkBanner.js';
import type { IdentityLink } from './contracts.js';

// "0 open pull requests" is a claim about someone's work. For an account that
// is not connected to a committer it is a false one, and this banner is what
// stops the product making it.

let link: IdentityLink;
let github = false;

beforeEach(() => {
  link = { state: 'unlinked', identity_id: null };
  github = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url.includes('/auth/identity') ? link : { local: true, oidc: null, github };
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

function renderBanner() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ForgeLinkBanner />
    </QueryClientProvider>,
  );
}

describe('ForgeLinkBanner (W15-04)', () => {
  it('tells an unlinked user their account is not connected to a committer', async () => {
    renderBanner();
    const banner = await screen.findByTestId('forge-link-banner');
    expect(banner).toHaveAttribute('data-link-state', 'unlinked');
    expect(banner).toHaveTextContent(/not connected to a forge account/i);
    // The sentence that matters: the emptiness is about us, not about them.
    expect(banner).toHaveTextContent(/not because you have no work/i);
  });

  it('offers the self-service route only where GitHub sign-in actually exists', async () => {
    github = true;
    renderBanner();
    await waitFor(() =>
      expect(screen.getByTestId('forge-link-banner')).toHaveTextContent(/Signing in with GitHub/i),
    );
  });

  it('stays silent for `no_activity` — that empty list is a true answer', async () => {
    // The account IS connected, so "you have no open PRs" is honest and needs
    // no correction. A shell-wide, undismissable stripe here would sit on every
    // screen forever for anyone who does not commit.
    link = { state: 'no_activity', identity_id: null };
    renderBanner();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('forge-link-banner')).not.toBeInTheDocument());
  });

  it('stays silent for a linked account — silence is the common case', async () => {
    link = { state: 'linked', identity_id: 7 };
    renderBanner();
    // Give the query a chance to resolve before asserting absence, or this
    // would pass even if the banner rendered a tick later.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('forge-link-banner')).not.toBeInTheDocument());
  });
});
