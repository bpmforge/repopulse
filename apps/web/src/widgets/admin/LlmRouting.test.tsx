import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { LlmRouting } from './LlmRouting.js';

// The leave-with-unsaved-changes guard (W20-16, AI-24) is the router's.
const blocker = vi.hoisted(() => ({ last: undefined as unknown }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (opts: unknown) => {
    blocker.last = opts;
  },
}));

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
  // host / leaves_network as the API reports them (describeEndpoint).
  providers: [
    {
      id: 1,
      name: 'LAN',
      kind: 'openai_compatible',
      model: 'lan-m',
      enabled: true,
      host: '10.0.0.5:1234',
      leaves_network: false,
    },
    {
      id: 2,
      name: 'Hosted',
      kind: 'openai_compatible',
      model: 'cloud-m',
      enabled: true,
      host: 'api.example-llm.com',
      leaves_network: true,
    },
    {
      id: 3,
      name: 'Off',
      kind: 'openai_compatible',
      model: 'x',
      enabled: false,
      host: '10.0.0.9:1234',
      leaves_network: false,
    },
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

describe('Settings → Models → Routing (W19-02)', () => {
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

  it('says in a sentence what each role will actually do: the chain with its models, or the shared pool', async () => {
    renderScreen();
    // security: a one-link chain, using the connection's own model.
    expect(await screen.findByTestId('routing-effective-security')).toHaveTextContent(
      'Uses LAN · lan-m. If it is down or refuses, the role skips and says so.',
    );
    // No chain: the shared pool of ENABLED connections only.
    const pool = screen.getByTestId('routing-effective-performance').textContent ?? '';
    expect(pool).toMatch(/^Uses the shared pool: LAN · lan-m, Hosted · cloud-m\.$/);
    expect(pool).not.toContain('Off');
  });

  it('updates the sentence as the chain is built, and states the local-only limit on the shared pool', async () => {
    renderScreen();
    await screen.findByTestId('routing-effective-security');
    await userEvent.selectOptions(screen.getByTestId('routing-add-security'), '2');
    expect(screen.getByTestId('routing-effective-security')).toHaveTextContent(
      'Tries LAN · lan-m; if it is down or refuses, then Hosted · cloud-m.',
    );
    await userEvent.type(screen.getByTestId('routing-model-security-1'), 'big-model');
    expect(screen.getByTestId('routing-effective-security')).toHaveTextContent(
      'then Hosted · big-model.',
    );
    await userEvent.click(screen.getByTestId('routing-local-only'));
    expect(screen.getByTestId('routing-effective-triage')).toHaveTextContent(
      /limited to connections on your network \(local-only is on\)/,
    );
  });

  // W20-06 (UX_TODO AI-05): each role says whether code leaves the network, and
  // the local-only pool sentence lists only connections that are on it.
  it('says per role whether code leaves the network, and limits the local-only pool for real', async () => {
    renderScreen();
    const security = await screen.findByTestId('routing-egress-security');
    expect(security).toHaveTextContent(/Stays on your network\. Uses LAN/);
    expect(screen.getByTestId('routing-egress-triage')).toHaveTextContent(
      /May leave your network: the shared pool includes Hosted \(api\.example-llm\.com\)/,
    );
    // A hosted link added on this screen takes its connection's host at once.
    await userEvent.selectOptions(screen.getByTestId('routing-add-patch'), '2');
    expect(screen.getByTestId('routing-egress-patch')).toHaveTextContent(
      /Leaves your network.*Hosted \(api\.example-llm\.com\) receives diffs/s,
    );

    await userEvent.click(screen.getByTestId('routing-local-only'));
    const pool = screen.getByTestId('routing-effective-triage').textContent ?? '';
    expect(pool).toContain('LAN · lan-m');
    expect(pool).not.toContain('Hosted');
    expect(screen.getByTestId('routing-egress-patch')).toHaveTextContent(/Blocked by Local only/);
  });

  // W20-06 (UX_TODO AI-03): a switched-off connection is named, not silently hidden.
  it('names switched-off connections instead of hiding them silently', async () => {
    renderScreen();
    expect(await screen.findByTestId('routing-switched-off')).toHaveTextContent(
      /Switched off, so not offered below: Off/,
    );
  });
});

describe('Routing friction (W20-11)', () => {
  const putBody = () =>
    JSON.parse(String(requests.find((r) => r.init?.method === 'PUT')?.init?.body)) as {
      local_only: boolean;
      roles: Record<string, { provider_id: number; model: string | null }[]>;
    };

  // UX_TODO AI-24: pending edits are announced, and can be discarded.
  it('says edits are unsaved until Save routing, and Discard puts the saved routing back', async () => {
    renderScreen();
    await screen.findByTestId('routing-row-security');
    expect(screen.queryByTestId('routing-unsaved')).toBeNull();
    await userEvent.click(screen.getByTestId('routing-local-only'));
    expect(screen.getByTestId('routing-unsaved')).toHaveTextContent(/nothing above applies/);
    // Leaving now asks, inside the app as well as on closing the tab (AI-24).
    expect(blocker.last).toMatchObject({ disabled: false, enableBeforeUnload: true });
    await userEvent.click(screen.getByTestId('routing-discard'));
    expect(blocker.last).toMatchObject({ disabled: true, enableBeforeUnload: false });
    expect(screen.queryByTestId('routing-unsaved')).toBeNull();
    expect(screen.getByTestId('routing-local-only')).not.toBeChecked();
  });

  // UX_TODO AI-25: a link can move down as well as up.
  it('moves a link down the chain', async () => {
    renderScreen();
    await screen.findByTestId('routing-row-security');
    await userEvent.selectOptions(screen.getByTestId('routing-add-security'), '2');
    expect(screen.getByTestId('routing-down-security-1')).toBeDisabled();
    await userEvent.click(screen.getByTestId('routing-down-security-0'));
    await userEvent.click(screen.getByTestId('routing-save'));
    await waitFor(() => expect(requests.some((r) => r.init?.method === 'PUT')).toBe(true));
    expect(putBody().roles.security!.map((l) => l.provider_id)).toEqual([2, 1]);
  });

  // UX_TODO AI-26: one connection for every role in one pick.
  it('applies one connection to every role', async () => {
    renderScreen();
    await screen.findByTestId('routing-row-security');
    await userEvent.selectOptions(screen.getByTestId('routing-apply-all'), '1');
    await userEvent.click(screen.getByTestId('routing-save'));
    await waitFor(() => expect(requests.some((r) => r.init?.method === 'PUT')).toBe(true));
    const roles = putBody().roles;
    expect(Object.keys(roles).sort()).toEqual([...ROLES].sort());
    for (const r of ROLES) expect(roles[r]).toEqual([{ provider_id: 1, model: null }]);
  });

  // UX_TODO AI-76: ticking Local only with an off-network link says which, and
  // offers to strip them, after asking.
  it('Local only with an off-network link names it and can strip it, after a confirm', async () => {
    renderScreen();
    await screen.findByTestId('routing-row-security');
    await userEvent.selectOptions(screen.getByTestId('routing-add-security'), '2');
    await userEvent.click(screen.getByTestId('routing-local-only'));
    expect(screen.getByTestId('routing-local-only-conflict')).toHaveTextContent(
      /1 link below leave/,
    );
    expect(screen.getByTestId('routing-will-remove-security-1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('routing-strip'));
    expect(requests.some((r) => r.init?.method === 'PUT')).toBe(false);
    await userEvent.click(screen.getByTestId('routing-strip-do'));
    await waitFor(() => expect(requests.some((r) => r.init?.method === 'PUT')).toBe(true));
    expect(putBody()).toMatchObject({
      local_only: true,
      roles: { security: [{ provider_id: 1, model: null }] },
    });
  });
});
