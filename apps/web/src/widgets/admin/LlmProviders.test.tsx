import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { LlmProviders, testNextStep } from './LlmProviders.js';

// W16-07 (D-LLM-1, F5). The screen that makes "bring your own LLM" true.
//
// The assertions that matter are about what a person can learn from it: that an
// unsupported provider says why BEFORE the form is filled, that a failed test
// shows the endpoint's own words rather than a generic failure, and that a
// saved provider is tested by id because the browser never has the key.

const KINDS = {
  kinds: [
    {
      kind: 'openai_compatible',
      label: 'OpenAI-compatible endpoint',
      auth_class: 'api_key',
      needs_base_url: true,
      supported: true,
      unsupported_reason: null,
      examples: ['http://localhost:11434/v1 (Ollama)'],
    },
    {
      kind: 'vertex',
      label: 'Google Vertex AI',
      auth_class: 'cloud_credentials',
      needs_base_url: false,
      supported: false,
      unsupported_reason:
        'Vertex authenticates with a Google service account rather than an API key. Support is W16-09.',
      examples: [],
    },
    {
      kind: 'claude_cli',
      label: 'Claude Code CLI you installed (customer-supplied)',
      auth_class: 'local_cli',
      needs_base_url: false,
      supported: true,
      unsupported_reason: null,
      examples: [],
      customer_supplied: true,
      requires_acceptance: true,
    },
  ],
};

const STATEMENT = {
  version: 'claude-cli.v1',
  sha256: 'abc123',
  title: 'Using your own Claude Code CLI with RepoPulse',
  points: [
    {
      heading: 'This is customer-supplied, not a RepoPulse feature.',
      text: 'You install it and sign in yourself.',
    },
    { heading: 'RepoPulse does not store or transmit your login.', text: 'It stays in the CLI.' },
    { heading: 'API keys remain the supported route.', text: 'Use the Anthropic provider.' },
  ],
};
let claudeBody: unknown = {
  statement: STATEMENT,
  accepted: null,
  cli: { found: true, version: '2.1.287 (Claude Code)', reportsLoggedIn: true, reason: null },
};

const requests: { url: string; init: RequestInit | undefined }[] = [];
let listBody: unknown = { items: [] };
let testBody: unknown = { ok: true, latency_ms: 40, model: 'qwen3-coder', sample: 'ok' };

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const body = url.includes('/claude-cli')
        ? claudeBody
        : url.includes('/kinds')
          ? KINDS
          : url.includes('/test')
            ? testBody
            : url.includes('/admin/llm-providers')
              ? listBody
              : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function renderScreen() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LlmProviders />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requests.length = 0;
  listBody = { items: [] };
  testBody = { ok: true, latency_ms: 40, model: 'qwen3-coder', sample: 'ok' };
  claudeBody = {
    statement: STATEMENT,
    accepted: null,
    cli: { found: true, version: '2.1.287 (Claude Code)', reportsLoggedIn: true, reason: null },
  };
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Models (W16-07)', () => {
  it('says why an unsupported provider is unavailable, before the form is filled', async () => {
    renderScreen();
    // Wait for the KINDS response, not just the form: the select renders empty
    // until it lands, and selecting into an empty select fails for the wrong
    // reason.
    await screen.findByRole('option', { name: /Vertex/ });

    await userEvent.selectOptions(screen.getByTestId('provider-kind'), 'vertex');

    const note = await screen.findByTestId('provider-unsupported');
    expect(note).toHaveTextContent(/service account/i);
    // And the form cannot be submitted into a failure.
    expect(screen.getByTestId('provider-save')).toBeDisabled();
  });

  it('hides the base URL for a vendor whose endpoint is fixed', async () => {
    renderScreen();
    await screen.findByRole('option', { name: /Vertex/ });
    expect(screen.getByTestId('provider-base-url')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId('provider-kind'), 'vertex');
    await waitFor(() => expect(screen.queryByTestId('provider-base-url')).toBeNull());
  });

  it('reports a successful test with the model the endpoint actually ran', async () => {
    testBody = { ok: true, latency_ms: 128, model: 'qwen3-coder-30b', sample: 'ok' };
    renderScreen();
    await screen.findByTestId('llm-provider-form');

    await userEvent.type(screen.getByTestId('provider-model'), 'qwen3-coder');
    await userEvent.click(screen.getByTestId('provider-test'));

    const result = await screen.findByTestId('provider-test-result');
    // Named separately from what was requested: a gateway may route elsewhere.
    expect(result).toHaveTextContent('qwen3-coder-30b');
    expect(result).toHaveTextContent('128ms');
  });

  it("shows the endpoint's own error text, not a generic failure", async () => {
    // The whole reason the button is worth having: "invalid api key", "model not
    // found" and a refused connection need three different fixes.
    testBody = { ok: false, stage: 'response', status: 404, detail: 'model not found: typo-3b' };
    renderScreen();
    await screen.findByTestId('llm-provider-form');

    await userEvent.type(screen.getByTestId('provider-model'), 'typo-3b');
    await userEvent.click(screen.getByTestId('provider-test'));

    expect(await screen.findByTestId('provider-test-result')).toHaveTextContent(
      'model not found: typo-3b',
    );
    // W20-11 (UX_TODO AI-21): and what to do about it.
    expect(screen.getByTestId('test-next-step')).toHaveTextContent(/does not know that model name/);
  });

  it('distinguishes a connection failure from a bad credential', async () => {
    testBody = { ok: false, stage: 'transport', detail: 'connect ECONNREFUSED 192.168.1.50:1234' };
    renderScreen();
    await screen.findByTestId('llm-provider-form');
    await userEvent.click(screen.getByTestId('provider-test'));

    const result = await screen.findByTestId('provider-test-result');
    expect(result).toHaveTextContent(/could not connect/i);
    expect(result).toHaveTextContent('ECONNREFUSED');
  });

  it('shows a saved provider by fingerprint, and tests it by id', async () => {
    listBody = {
      items: [
        {
          id: 7,
          name: 'OpenRouter',
          kind: 'openai_compatible',
          base_url: 'https://openrouter.ai/api/v1',
          model: 'qwen/qwen3-coder',
          credential: 'cdef',
          headers: null,
          allow_public_host: true,
          enabled: true,
        },
      ],
    };
    renderScreen();

    const row = await screen.findByTestId('provider-row-7');
    expect(row).toHaveTextContent('cdef');
    // The key itself is never in the document, because it is never sent here.
    expect(row).not.toHaveTextContent('sk-');
    // Off-network is called out, not buried: it is the row that sends diffs off
    // this network.
    expect(row).toHaveTextContent(/yes/);

    await userEvent.click(screen.getByTestId('provider-test-7'));

    await waitFor(() => {
      const call = requests.find((r) => r.url.includes('/test'));
      expect(call).toBeTruthy();
      // By id — the browser has no key to send, so the server decrypts it.
      expect(JSON.parse(String(call?.init?.body))).toEqual({ id: 7, probe: true });
    });
  });

  it('puts the by-hand form behind Advanced once a connection exists, and keeps it open when none does', async () => {
    // No connection yet: the form IS the way in, so it is not tucked away.
    renderScreen();
    await screen.findByTestId('llm-provider-form');
    expect(screen.queryByTestId('llm-advanced')).toBeNull();
    cleanup();

    listBody = {
      items: [
        {
          id: 7,
          name: 'LM Studio',
          kind: 'openai_compatible',
          base_url: 'http://10.0.0.5:1234/v1',
          model: 'm',
          credential: null,
          headers: null,
          allow_public_host: false,
          enabled: true,
        },
      ],
    };
    renderScreen();
    await screen.findByTestId('provider-row-7');
    const advanced = screen.getByTestId('llm-advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')).toHaveTextContent(
      'Advanced: add a connection by hand',
    );
    // The form is inside it, and the list of connections is not.
    expect(advanced).toContainElement(screen.getByTestId('llm-provider-form'));
    expect(advanced).not.toContainElement(screen.getByTestId('provider-table'));
  });

  it('says what an empty state means for analysis', async () => {
    renderScreen();
    expect(await screen.findByText(/analysis will skip and say so/i)).toBeInTheDocument();
  });

  describe('presets and capabilities (W19-01)', () => {
    const CAPS = {
      contextWindow: 262144,
      streaming: 'yes',
      jsonMode: 'yes',
      toolUse: 'unknown',
      notes: ['JSON mode works through `json_schema`, not `json_object`.'],
      probedAt: '2026-10-17T00:00:00.000Z',
    };

    it('a preset fills the provider and URL, leaving the model to the person', async () => {
      (KINDS as Record<string, unknown>).presets = [
        {
          id: 'lmstudio',
          label: 'LM Studio',
          kind: 'openai_compatible',
          baseUrl: 'http://localhost:1234/v1',
          note: 'Start the local server and load a model.',
        },
      ];
      renderScreen();
      await userEvent.click(await screen.findByTestId('preset-lmstudio'));
      expect(screen.getByTestId('provider-base-url')).toHaveValue('http://localhost:1234/v1');
      expect(screen.getByTestId('provider-name')).toHaveValue('LM Studio');
      // Never guessed: a preset cannot know which model is loaded.
      expect(screen.getByTestId('provider-model')).toHaveValue('');
    });

    it('shows what the probe found next to a saved provider, with unknown kept as unknown', async () => {
      listBody = {
        items: [
          {
            id: 3,
            name: 'LM',
            kind: 'openai_compatible',
            base_url: 'http://localhost:1234/v1',
            model: 'm',
            credential: null,
            headers: null,
            allow_public_host: false,
            enabled: true,
            capabilities: CAPS,
            probed_at: CAPS.probedAt,
          },
        ],
      };
      renderScreen();
      const cell = await screen.findByTestId('provider-capabilities-3');
      expect(cell).toHaveTextContent('262144 tokens');
      expect(cell).toHaveTextContent('Streaming: ✓ yes');
      expect(cell).toHaveTextContent('Tool use: ? unknown');
      expect(cell).toHaveTextContent('json_schema');
    });

    it('shows the capability sentence that blocks a model, in the test result', async () => {
      testBody = {
        ok: true,
        latency_ms: 10,
        model: 'm',
        sample: 'ok',
        capabilities: { ...CAPS, contextWindow: 4096, streaming: 'no' },
        problems: ['This server does not stream responses, and every analysis call is streamed.'],
      };
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-test'));
      expect(await screen.findByTestId('capability-problem')).toHaveTextContent(/does not stream/);
    });
  });

  describe('the customer-supplied Claude Code CLI option (W19-08)', () => {
    const pick = async () => {
      renderScreen();
      await screen.findByRole('option', { name: /customer-supplied/ });
      await userEvent.selectOptions(screen.getByTestId('provider-kind'), 'claude_cli');
    };

    it('is labelled customer-supplied in the choice, and shows the whole statement before anything else', async () => {
      await pick();
      expect(
        screen.getByRole('option', { name: /Claude Code CLI you installed \(customer-supplied\)/ }),
      ).toBeInTheDocument();
      const panel = await screen.findByTestId('claude-cli-panel');
      expect(panel).toHaveTextContent('Customer-supplied.');
      expect(panel).toHaveTextContent('It is not a RepoPulse feature');
      expect(screen.getByTestId('claude-cli-statement')).toHaveTextContent(
        /does not store or transmit your login/,
      );
      expect(screen.getByTestId('claude-cli-statement')).toHaveTextContent(
        /API keys remain the supported route/,
      );
    });

    it('is OFF: Add provider stays disabled until the statement is accepted, and there is no key or address to enter', async () => {
      await pick();
      await screen.findByTestId('claude-cli-panel');
      expect(screen.getByTestId('provider-save')).toBeDisabled();
      expect(screen.queryByTestId('provider-api-key')).toBeNull();
      expect(screen.queryByTestId('provider-base-url')).toBeNull();
      expect(screen.queryByTestId('provider-allow-public')).toBeNull();
      expect(screen.getByTestId('claude-cli-no-key')).toHaveTextContent(/keeps its own login/);
    });

    it('cannot be accepted without ticking that it was read, then posts exactly the version and hash shown', async () => {
      await pick();
      const accept = await screen.findByTestId('claude-cli-accept');
      expect(accept).toBeDisabled();
      await userEvent.click(screen.getByTestId('claude-cli-read'));
      expect(accept).toBeEnabled();
      await userEvent.click(accept);
      await waitFor(() => {
        const call = requests.find((r) => r.url.endsWith('/claude-cli/accept'));
        expect(call).toBeTruthy();
        expect(JSON.parse(String(call?.init?.body))).toEqual({
          accept: true,
          statement_version: 'claude-cli.v1',
          statement_sha256: 'abc123',
        });
      });
    });

    it('once accepted: shows who and when, enables Add provider, and offers to switch it off', async () => {
      claudeBody = {
        statement: STATEMENT,
        accepted: {
          by: 'brad',
          at: '2026-10-18T10:00:00.000Z',
          version: 'claude-cli.v1',
          current: true,
        },
        cli: { found: true, version: '2.1.287 (Claude Code)', reportsLoggedIn: true, reason: null },
      };
      await pick();
      const done = await screen.findByTestId('claude-cli-accepted');
      expect(done).toHaveTextContent('Accepted by brad on 2026-10-18');
      await userEvent.type(screen.getByTestId('provider-name'), 'My Claude');
      await userEvent.type(screen.getByTestId('provider-model'), 'sonnet');
      await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled());
      expect(screen.getByTestId('claude-cli-revoke')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('provider-save'));
      await waitFor(() => {
        const call = requests.find(
          (r) => r.init?.method === 'POST' && r.url.endsWith('/admin/llm-providers'),
        );
        expect(JSON.parse(String(call?.init?.body))).toMatchObject({
          kind: 'claude_cli',
          api_key: null,
          base_url: null,
          allow_public_host: false,
        });
      });
    });

    it('treats an acceptance of an OLDER statement as not accepted, and says the wording changed', async () => {
      claudeBody = {
        statement: STATEMENT,
        accepted: {
          by: 'brad',
          at: '2026-09-01T00:00:00.000Z',
          version: 'claude-cli.v0',
          current: false,
        },
        cli: { found: true, version: 'x', reportsLoggedIn: null, reason: null },
      };
      await pick();
      expect(
        await screen.findByText(/statement has changed since it was accepted/),
      ).toBeInTheDocument();
      expect(screen.getByTestId('provider-save')).toBeDisabled();
      expect(screen.queryByTestId('claude-cli-accepted')).toBeNull();
    });

    it('says plainly when the CLI is not on the server, and that signed-in is only a hint', async () => {
      claudeBody = {
        statement: STATEMENT,
        accepted: null,
        cli: {
          found: false,
          version: null,
          reportsLoggedIn: null,
          reason:
            'The Claude Code CLI ("claude") was not found. It is customer-supplied: install it in this container and sign in.',
        },
      };
      await pick();
      expect(await screen.findByTestId('claude-cli-status')).toHaveTextContent(
        /was not found.*customer-supplied/s,
      );
    });

    it('marks the saved connection as customer-supplied and as leaving the network, with no key shown', async () => {
      listBody = {
        items: [
          {
            id: 9,
            name: 'My Claude',
            kind: 'claude_cli',
            base_url: null,
            model: 'sonnet',
            credential: null,
            headers: null,
            allow_public_host: false,
            enabled: true,
            capabilities: null,
            probed_at: null,
          },
        ],
      };
      renderScreen();
      const row = await screen.findByTestId('provider-row-9');
      expect(row).toHaveTextContent('Claude Code CLI · customer-supplied');
      expect(row).toHaveTextContent('your Claude Code CLI');
      expect(row).toHaveTextContent('the CLI keeps its own login');
      expect(row).toHaveTextContent('⚠ yes');
    });
  });

  it('says which saved connections are reached by a host name, and what that now means (IPs only)', async () => {
    const base = {
      kind: 'openai_compatible',
      model: 'm',
      credential: null,
      headers: null,
      enabled: true,
      capabilities: null,
      probed_at: null,
    };
    listBody = {
      items: [
        {
          ...base,
          id: 11,
          name: 'NAS',
          base_url: 'http://nas.local:1234/v1',
          allow_public_host: true,
          host: 'nas.local:1234',
          leaves_network: true,
          host_is_name: true,
        },
        {
          ...base,
          id: 12,
          name: 'By IP',
          base_url: 'http://10.0.0.7:1234/v1',
          allow_public_host: false,
          host: '10.0.0.7:1234',
          leaves_network: false,
          host_is_name: false,
        },
      ],
    };
    renderScreen();
    const note = await screen.findByTestId('provider-name-host-11');
    expect(note).toHaveTextContent(
      /host name, so it counts as leaving your network.*audited.*Local only refuses it.*IP address/s,
    );
    expect(screen.queryByTestId('provider-name-host-12')).toBeNull();
  });

  // W20-06 (UX_TODO AI-01 to AI-04): each saved connection owns its Test result,
  // its errors, an Edit, a switch, and a Remove that says what it drops.
  describe('a saved connection row (W20-06)', () => {
    const row7 = {
      id: 7,
      name: 'LM Studio',
      kind: 'openai_compatible',
      base_url: 'http://10.0.0.5:1234/v1',
      model: 'm',
      credential: null,
      headers: null,
      allow_public_host: false,
      enabled: true,
      capabilities: null,
      probed_at: null,
      host: '10.0.0.5:1234',
      leaves_network: false,
    };
    const ROUTING = {
      local_only: false,
      roles: [
        { role: 'security', chain: [{ provider_id: 7 }] },
        { role: 'patch', chain: [{ provider_id: 7 }, { provider_id: 9 }] },
        { role: 'triage', chain: [] },
      ],
      providers: [],
    };
    let failing: { method: string; status: number; body: unknown } | null = null;

    beforeEach(() => {
      failing = null;
      listBody = { items: [row7] };
      vi.stubGlobal(
        'fetch',
        vi.fn((input: unknown, init?: RequestInit) => {
          const url = String(input);
          requests.push({ url, init });
          const method = init?.method ?? 'GET';
          if (failing && failing.method === method) {
            return Promise.resolve(
              new Response(JSON.stringify(failing.body), {
                status: failing.status,
                headers: { 'content-type': 'application/problem+json' },
              }),
            );
          }
          const body = url.includes('/llm-routing')
            ? ROUTING
            : url.includes('/kinds')
              ? KINDS
              : url.includes('/test')
                ? testBody
                : method === 'PATCH'
                  ? { id: 7, enabled: false, routed_roles: ['patch', 'security'] }
                  : method === 'DELETE'
                    ? null
                    : listBody;
          return Promise.resolve(
            body === null
              ? new Response(null, { status: 204 })
              : new Response(JSON.stringify(body), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
          );
        }),
      );
    });

    it('AI-01: shows the row Test result next to the row, not inside the folded form', async () => {
      testBody = { ok: false, stage: 'transport', detail: 'connect ECONNREFUSED 10.0.0.5:1234' };
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-test-7'));
      const result = await screen.findByTestId('provider-row-test-result-7');
      expect(result).toHaveTextContent(/Could not connect\..*ECONNREFUSED/s);
      expect(screen.getByTestId('provider-row-detail-7')).toContainElement(result);
      expect(screen.getByTestId('llm-advanced')).not.toContainElement(result);
    });

    it('AI-02: a failed Test request is shown beside the row', async () => {
      failing = {
        method: 'POST',
        status: 500,
        body: { title: 'Internal Server Error', status: 500 },
      };
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-test-7'));
      expect(await screen.findByTestId('provider-row-test-error-7')).toBeInTheDocument();
    });

    it('AI-04: Remove asks first, names the roles it drops, and shows a refusal', async () => {
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-delete-7'));
      expect(requests.some((r) => r.init?.method === 'DELETE')).toBe(false);
      expect(screen.getByTestId('provider-confirm-7')).toHaveTextContent(
        /Remove LM Studio\? This cannot be undone\. It is removed from 2 roles: Security, Patch/,
      );
      failing = { method: 'DELETE', status: 409, body: { title: 'Conflict', status: 409 } };
      await userEvent.click(screen.getByTestId('provider-confirm-do-7'));
      expect(await screen.findByTestId('provider-remove-error-7')).toBeInTheDocument();

      failing = null;
      await userEvent.click(screen.getByTestId('provider-confirm-do-7'));
      await waitFor(() =>
        expect(
          requests.filter(
            (r) => r.init?.method === 'DELETE' && r.url.endsWith('/admin/llm-providers/7'),
          ),
        ).toHaveLength(2),
      );
    });

    it('AI-03: Switch off confirms with the roles affected, then PATCHes enabled=false', async () => {
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-toggle-7'));
      expect(screen.getByTestId('provider-confirm-7')).toHaveTextContent(
        /Switch off LM Studio\? It stops serving 2 roles: Security, Patch/,
      );
      await userEvent.click(screen.getByTestId('provider-confirm-do-7'));
      await waitFor(() => {
        const call = requests.find((r) => r.init?.method === 'PATCH');
        expect(call?.url).toMatch(/\/admin\/llm-providers\/7$/);
        expect(JSON.parse(String(call?.init?.body))).toEqual({ enabled: false });
      });
    });

    it('AI-03: Edit changes model and address, keeps the key unless a new one is typed, and shows a refusal', async () => {
      renderScreen();
      await userEvent.click(await screen.findByTestId('provider-edit-7'));
      const model = screen.getByTestId('provider-edit-model-7');
      await userEvent.clear(model);
      await userEvent.type(model, 'qwen3-coder');
      const url = screen.getByTestId('provider-edit-base-url-7');
      await userEvent.clear(url);
      await userEvent.type(url, 'http://10.0.0.6:1234/v1');
      await userEvent.click(screen.getByTestId('provider-edit-save-7'));
      await waitFor(() => {
        const call = requests.find((r) => r.init?.method === 'PATCH');
        expect(JSON.parse(String(call?.init?.body))).toEqual({
          name: 'LM Studio',
          model: 'qwen3-coder',
          base_url: 'http://10.0.0.6:1234/v1',
        });
      });

      failing = {
        method: 'PATCH',
        status: 400,
        body: {
          title: 'This provider cannot be used',
          detail: 'api.example.com is a public host.',
          status: 400,
        },
      };
      await userEvent.click(screen.getByTestId('provider-edit-7'));
      await userEvent.type(screen.getByTestId('provider-edit-api-key-7'), 'sk-new');
      await userEvent.click(screen.getByTestId('provider-edit-save-7'));
      expect(await screen.findByTestId('provider-patch-detail-7')).toHaveTextContent(
        'api.example.com is a public host.',
      );
      const last = requests.filter((r) => r.init?.method === 'PATCH').at(-1);
      expect(JSON.parse(String(last?.init?.body))).toMatchObject({ api_key: 'sk-new' });
    });

    it('AI-86: Off-network follows where the endpoint is, so a CLI or host-name row says yes', async () => {
      listBody = {
        items: [
          { ...row7, id: 8, name: 'CLI', kind: 'claude_cli', base_url: null, leaves_network: true },
        ],
      };
      renderScreen();
      expect(await screen.findByTestId('provider-off-network-8')).toHaveTextContent('yes');
    });
  });
});

// W20-11 (UX_TODO AI-21): a failed test names a next step, by what failed.
describe('testNextStep', () => {
  it('maps the common failures to a next step, and a success to none', () => {
    expect(testNextStep({ ok: true })).toBeNull();
    expect(
      testNextStep({ ok: false, detail: 'The model has crashed without additional information' }),
    ).toMatch(/reload it/);
    expect(testNextStep({ ok: false, status: 401, detail: 'Unauthorized' })).toMatch(
      /key was refused/,
    );
    expect(testNextStep({ ok: false, status: 429, detail: '' })).toMatch(/rate or quota/);
    expect(testNextStep({ ok: false, detail: 'connect ECONNREFUSED 10.0.0.5:1234' })).toMatch(
      /Nothing answered/,
    );
  });
});

describe('Claude Code CLI switch-off and acceptance on the row (W20-11)', () => {
  const accepted = {
    statement: STATEMENT,
    accepted: {
      by: 'brad',
      at: '2026-10-18T10:00:00.000Z',
      version: 'claude-cli.v1',
      current: true,
    },
    cli: { found: true, version: '2.1.287 (Claude Code)', reportsLoggedIn: true, reason: null },
  };
  const pick = async () => {
    renderScreen();
    await screen.findByRole('option', { name: /customer-supplied/ });
    await userEvent.selectOptions(screen.getByTestId('provider-kind'), 'claude_cli');
  };

  // UX_TODO AI-75: Switch off asks first, and then says the CLI is still there.
  it('Switch off asks first, then says how to remove the CLI itself', async () => {
    claudeBody = accepted;
    await pick();
    await userEvent.click(await screen.findByTestId('claude-cli-revoke'));
    expect(screen.getByTestId('claude-cli-revoke-confirm')).toHaveTextContent(
      /Switch off the Claude Code CLI\?/,
    );
    expect(requests.some((r) => r.url.endsWith('/claude-cli/accept'))).toBe(false);
    claudeBody = { ...accepted, accepted: null };
    await userEvent.click(screen.getByTestId('claude-cli-revoke-do'));
    expect(await screen.findByTestId('claude-cli-signout')).toHaveTextContent(
      /still installed and signed in inside the worker/,
    );
  });

  // UX_TODO AI-73 (W20-16): both containers' checks, each named.
  it("shows the worker's own CLI check beside the API container's", async () => {
    claudeBody = {
      ...accepted,
      cli: { found: false, version: null, reportsLoggedIn: null, reason: 'no "claude" here' },
      worker_cli: {
        found: true,
        version: '2.1.287 (Claude Code)',
        reportsLoggedIn: true,
        reason: null,
        checked_at: '2026-10-20T00:00:00.000Z',
      },
    };
    await pick();
    expect(await screen.findByTestId('claude-cli-status-worker')).toHaveTextContent(
      /Worker container \(runs every pass\): found 2\.1\.287/,
    );
    expect(screen.getByTestId('claude-cli-status-api')).toHaveTextContent(/API container/);
    expect(screen.getByTestId('claude-cli-status-mismatch')).toHaveTextContent(/--with-claude-cli/);
  });

  // UX_TODO AI-67: a CLI row says whether the statement is accepted.
  it('a saved CLI row says when the statement is not accepted, so it is not used', async () => {
    claudeBody = { ...accepted, accepted: null };
    listBody = {
      items: [
        {
          id: 9,
          name: 'My Claude',
          kind: 'claude_cli',
          base_url: null,
          model: 'sonnet',
          credential: null,
          headers: null,
          allow_public_host: false,
          enabled: true,
          capabilities: null,
          probed_at: null,
        },
      ],
    };
    renderScreen();
    expect(await screen.findByTestId('provider-cli-acceptance-9')).toHaveTextContent(
      /Not accepted: this connection is not used/,
    );
  });
});
