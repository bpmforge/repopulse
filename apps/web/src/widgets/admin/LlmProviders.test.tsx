import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { LlmProviders } from './LlmProviders.js';

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
  ],
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
      const body = url.includes('/kinds')
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
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe('Admin → Models (W16-07)', () => {
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
      expect(JSON.parse(String(call?.init?.body))).toEqual({ id: 7 });
    });
  });

  it('says what an empty state means for analysis', async () => {
    renderScreen();
    expect(await screen.findByText(/analysis will skip and say so/i)).toBeInTheDocument();
  });
});
