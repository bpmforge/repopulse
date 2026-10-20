import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SetupChecklist } from '../../widgets/admin/SetupChecklist.js';

// The setup checklist (W11-02, E1.2).

function renderWith(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(routes).find((route) => url.includes(route));
      return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SetupChecklist linkActions={false} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const status = {
  ready: false,
  checks: [
    {
      id: 'forge_connection',
      label: 'Forge connection',
      status: 'missing',
      detail: 'No forge connection yet.',
      docs: 'docs/INSTALL.md#connect-your-forge',
    },
    {
      id: 'webhook',
      label: 'Webhook deliveries',
      status: 'unknown',
      detail: 'No webhook delivery has arrived yet.',
      docs: 'docs/INSTALL.md#webhooks',
    },
  ],
};

const config = {
  variables: [
    {
      name: 'TOKEN_ENC_KEY',
      scope: 'api',
      required: true,
      purpose: 'Encrypts forge tokens at rest.',
      if_wrong: 'Boot fails.',
      default: null,
      secret: true,
      set: true,
    },
  ],
};

describe('setup checklist', () => {
  it('shows what is still outstanding, with where to read about it', async () => {
    renderWith({ '/setup/status': status, '/setup/config': config });
    expect(await screen.findByTestId('setup-forge_connection')).toHaveTextContent(
      'No forge connection yet',
    );
    expect(screen.getByTestId('setup-forge_connection')).toHaveTextContent('INSTALL.md');
  });

  it('renders "not known yet" as its own state, not as a fault', async () => {
    // A webhook that has not fired is a fact about history, not a misconfig —
    // showing it as a failure sends operators hunting for nothing.
    renderWith({ '/setup/status': status, '/setup/config': config });
    expect(await screen.findByTestId('setup-webhook-status')).toHaveAccessibleName('not known yet');
  });

  it('says whether a secret is SET and never shows a value', async () => {
    renderWith({ '/setup/status': status, '/setup/config': config });
    expect(await screen.findByTestId('config-TOKEN_ENC_KEY-set')).toHaveTextContent('yes');
    // The payload carries no value at all, so there is nothing to leak — this
    // asserts the screen does not invent one either.
    expect(screen.queryByText(/[0-9a-f]{64}/)).toBeNull();
  });
});
