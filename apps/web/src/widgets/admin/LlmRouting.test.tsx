import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { LlmRouting } from './LlmRouting.js';

// W19-02. The assertions that matter: the chain a person builds is what is
// sent, and the API's local-only sentence reaches the screen verbatim.

const ROLES = [
  'security',
  'performance',
  'code_health',
  'best_practices',
  'ai_slop',
  'test_coverage',
  'triage',
  'patch',
];
const STATE = {
  local_only: false,
  roles: ROLES.map((role) => ({
    role,
    chain: role === 'security' ? [{ provider_id: 1, provider_name: 'LAN', model: null }] : [],
  })),
  providers: [
    { id: 1, name: 'LAN', kind: 'openai_compatible', model: 'lan-m', enabled: true },
    { id: 2, name: 'Hosted', kind: 'openai_compatible', model: 'cloud-m', enabled: true },
    { id: 3, name: 'Off', kind: 'openai_compatible', model: 'x', enabled: false },
  ],
};

const requests: { url: string; init: RequestInit | undefined }[] = [];
let putResponse: { status: number; body: unknown } = { status: 204, body: null };

beforeEach(() => {
  requests.length = 0;
  putResponse = { status: 204, body: null };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === 'PUT') {
        return Promise.resolve(
          new Response(putResponse.body === null ? null : JSON.stringify(putResponse.body), {
            status: putResponse.status,
            headers: { 'content-type': 'application/problem+json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(STATE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderScreen() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LlmRouting />
    </QueryClientProvider>,
  );
}

describe('Admin → Models → Routing (W19-02)', () => {
  it('lists every role, shows existing chains, and offers only enabled connections', async () => {
    renderScreen();
    const row = await screen.findByTestId('routing-row-security');
    expect(row).toHaveTextContent('LAN');
    expect(screen.getByTestId('routing-row-patch')).toHaveTextContent('shared pool');
    const add = within(screen.getByTestId('routing-add-patch'));
    expect(add.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Add a connection…',
      'LAN',
      'Hosted',
    ]);
    expect(screen.getAllByTestId(/^routing-row-/)).toHaveLength(ROLES.length);
  });

  it('sends the chain in the order built, with the local-only switch', async () => {
    renderScreen();
    await screen.findByTestId('routing-row-security');
    await userEvent.selectOptions(screen.getByTestId('routing-add-security'), '2');
    await userEvent.type(screen.getByTestId('routing-model-security-1'), 'big-model');
    await userEvent.click(screen.getByTestId('routing-local-only'));
    await userEvent.click(screen.getByTestId('routing-save'));

    await waitFor(() => {
      const put = requests.find((r) => r.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        local_only: true,
        roles: {
          security: [
            { provider_id: 1, model: null },
            { provider_id: 2, model: 'big-model' },
          ],
        },
      });
    });
    expect(await screen.findByTestId('routing-saved')).toBeInTheDocument();
  });

  it("prints the API's local-only sentence, naming the role and connection", async () => {
    putResponse = {
      status: 422,
      body: {
        title: 'Local-only is on, and a role would leave your network',
        detail:
          'Local-only is on: role "security" would send to connection "Hosted", which is outside your network.',
        status: 422,
      },
    };
    renderScreen();
    await screen.findByTestId('routing-row-security');
    await userEvent.click(screen.getByTestId('routing-save'));
    expect(await screen.findByTestId('routing-error-detail')).toHaveTextContent(
      /role "security" would send to connection "Hosted"/,
    );
  });
});
