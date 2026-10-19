import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { ModelsWizard } from './ModelsWizard.js';

// W19-07. A person is walked from "where does it run" to "what leaves my
// network, per role". What matters: the wording about what leaves, that a hosted
// connection cannot be saved without saying so, that existing routing survives,
// and that the server's local-only refusal reaches the screen.

const KINDS = {
  kinds: [
    {
      kind: 'openai_compatible',
      label: 'OpenAI-compatible endpoint',
      needs_base_url: true,
      supported: true,
    },
    { kind: 'anthropic', label: 'Anthropic (Claude API)', needs_base_url: false, supported: true },
    { kind: 'gemini', label: 'Google Gemini (API key)', needs_base_url: false, supported: true },
    { kind: 'copilot', label: 'GitHub Copilot', needs_base_url: false, supported: false },
    {
      kind: 'claude_cli',
      label: 'Claude Code CLI you installed (customer-supplied)',
      needs_base_url: false,
      supported: true,
    },
  ],
  presets: [
    {
      id: 'lmstudio',
      label: 'LM Studio',
      kind: 'openai_compatible',
      baseUrl: 'http://localhost:1234/v1',
      note: 'n',
    },
  ],
};
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
const lan = {
  id: 1,
  name: 'LM Studio',
  enabled: true,
  host: '10.0.0.5:1234',
  leaves_network: false,
};
const cloud = {
  id: 2,
  name: 'Gemini',
  enabled: true,
  host: 'generativelanguage.googleapis.com',
  leaves_network: true,
};

let routing: unknown;
let testBody: unknown;
let createStatus = 201;
let putStatus = 204;
let putBody: unknown = null;
const requests: { url: string; init: RequestInit | undefined }[] = [];

const json = (b: unknown, status = 200) =>
  new Response(b === null ? null : JSON.stringify(b), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

beforeEach(() => {
  requests.length = 0;
  createStatus = 201;
  putStatus = 204;
  putBody = null;
  testBody = {
    ok: true,
    latency_ms: 40,
    model: 'm',
    capabilities: {
      contextWindow: 262144,
      streaming: 'yes',
      jsonMode: 'yes',
      toolUse: 'yes',
      notes: [],
      probedAt: 'x',
    },
    problems: [],
  };
  routing = {
    local_only: false,
    roles: ROLES.map((role) => ({
      role,
      chain:
        role === 'security'
          ? [
              {
                provider_id: 1,
                provider_name: 'LM Studio',
                model: null,
                host: '10.0.0.5:1234',
                leaves_network: false,
              },
            ]
          : [],
    })),
    providers: [lan],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === 'PUT') return Promise.resolve(json(putBody, putStatus));
      if (init?.method === 'POST' && url.endsWith('/test')) return Promise.resolve(json(testBody));
      if (init?.method === 'POST')
        return Promise.resolve(json({ id: 7, capabilities: null }, createStatus));
      if (url.includes('/kinds')) return Promise.resolve(json(KINDS));
      if (url.includes('/admin/llm-routing')) return Promise.resolve(json(routing));
      return Promise.resolve(json({ items: [] }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ModelsWizard />
    </QueryClientProvider>,
  );
const posted = (suffix: string) =>
  requests
    .filter((r) => r.init?.method === 'POST' && r.url.endsWith(suffix))
    .map((r) => JSON.parse(String(r.init?.body)));

describe('step 1: where does it run', () => {
  it('states plainly what leaves the network for each choice, before anything is entered', async () => {
    renderIt();
    expect(await screen.findByTestId('wizard-leaves-local')).toHaveTextContent(
      'Nothing leaves your network.',
    );
    expect(screen.getByTestId('wizard-leaves-proxy')).toHaveTextContent(
      /gateway receives diffs, pull-request descriptions and file paths/,
    );
    expect(screen.getByTestId('wizard-leaves-hosted')).toHaveTextContent(
      /vendor receives diffs.*egress audit/s,
    );
  });

  it('marks the current step for assistive technology and moves focus to its heading', async () => {
    renderIt();
    const steps = await screen.findByTestId('wizard-steps');
    expect(within(steps).getByText(/1\. Where it runs/)).toHaveAttribute('aria-current', 'step');
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    expect(within(steps).getByText(/2\. Connect and test/)).toHaveAttribute('aria-current', 'step');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Connect and test it' })).toHaveFocus(),
    );
  });
});

describe('step 2: connect and test', () => {
  async function toConnect(where: 'local' | 'proxy' | 'hosted') {
    renderIt();
    await userEvent.click(await screen.findByTestId(`wizard-where-${where}`));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
  }

  it('tells a local user to use an IP address (and that localhost is the container), but not a hosted one', async () => {
    await toConnect('local');
    expect(await screen.findByTestId('wizard-address-hint')).toHaveTextContent(
      /IP address.*host names are not accepted.*container itself/s,
    );
  });

  it('local: a preset fills the address and the test sends the probe request', async () => {
    await toConnect('local');
    await userEvent.click(await screen.findByTestId('wizard-preset-lmstudio'));
    expect(screen.getByTestId('wizard-base-url')).toHaveValue('http://localhost:1234/v1');
    expect(screen.getByTestId('wizard-name')).toHaveValue('LM Studio');
    await userEvent.type(screen.getByTestId('wizard-model'), 'qwen/qwen3.8-27b');
    await userEvent.click(screen.getByTestId('wizard-test'));
    expect(await screen.findByTestId('wizard-test-result')).toHaveTextContent('Reached it.');
    expect(screen.getByTestId('capabilities')).toHaveTextContent('262144 tokens');
    expect(posted('/test')[0]).toMatchObject({
      kind: 'openai_compatible',
      base_url: 'http://localhost:1234/v1',
      model: 'qwen/qwen3.8-27b',
      allow_public_host: false,
      probe: true,
    });
  });

  it('shows the sentence that blocks a model that cannot run a pass', async () => {
    testBody = {
      ok: true,
      latency_ms: 1,
      model: 'm',
      capabilities: {
        contextWindow: 4096,
        streaming: 'no',
        jsonMode: 'no',
        toolUse: 'no',
        notes: [],
        probedAt: 'x',
      },
      problems: ['This server does not stream responses, and every analysis call is streamed.'],
    };
    await toConnect('local');
    await userEvent.type(await screen.findByTestId('wizard-model'), 'tiny');
    await userEvent.click(screen.getByTestId('wizard-test'));
    expect(await screen.findByTestId('wizard-problem')).toHaveTextContent(/does not stream/);
  });

  it("reports a failed connection in the server's own words", async () => {
    testBody = { ok: false, stage: 'transport', detail: 'connect ECONNREFUSED 127.0.0.1:1234' };
    await toConnect('local');
    await userEvent.type(await screen.findByTestId('wizard-model'), 'm');
    await userEvent.click(screen.getByTestId('wizard-test'));
    const r = await screen.findByTestId('wizard-test-result');
    expect(r).toHaveTextContent('Could not connect.');
    expect(r).toHaveTextContent('ECONNREFUSED');
  });

  it('says, next to the greyed-out buttons, what is missing', async () => {
    await toConnect('hosted');
    await screen.findByTestId('wizard-kind');
    // Nothing entered yet: Test and Save both say what they are waiting for.
    expect(screen.getByTestId('wizard-test')).toBeDisabled();
    expect(screen.getByTestId('wizard-test-hint')).toHaveTextContent(
      'To test the connection: enter the model name.',
    );
    expect(screen.getByTestId('wizard-save-hint').textContent).toMatch(
      /give the connection a name; enter the model name; tick the box above/,
    );
    expect(screen.getByTestId('wizard-save')).toHaveAttribute(
      'aria-describedby',
      'wizard-save-hint',
    );
    await userEvent.type(screen.getByTestId('wizard-name'), 'Gemini');
    expect(screen.getByTestId('wizard-save-hint').textContent).not.toMatch(
      /give the connection a name/,
    );
    await userEvent.type(screen.getByTestId('wizard-model'), 'gemini-2.5-flash');
    // Test is ready: its hint is gone. Save still needs the acknowledgement.
    expect(screen.queryByTestId('wizard-test-hint')).toBeNull();
    expect(screen.getByTestId('wizard-save-hint').textContent).toMatch(
      /^To save: tick the box above/,
    );
    await userEvent.click(screen.getByTestId('wizard-outside'));
    expect(screen.queryByTestId('wizard-save-hint')).toBeNull();
    expect(screen.getByTestId('wizard-save')).not.toHaveAttribute('aria-describedby');
  });

  it('hosted: offers only supported vendors, hides the address for a fixed endpoint, and cannot be saved without acknowledging what is sent', async () => {
    await toConnect('hosted');
    const options = within(await screen.findByTestId('wizard-kind'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'OpenAI-compatible endpoint',
      'Anthropic (Claude API)',
      'Google Gemini (API key)',
    ]);
    expect(screen.queryByText(/Copilot/)).toBeNull();
    // The customer-supplied CLI option is deliberately not on the guided path: it
    // is gated behind an accepted statement and lives in the full form.
    expect(screen.queryByText(/Claude Code CLI/)).toBeNull();
    await userEvent.selectOptions(screen.getByTestId('wizard-kind'), 'gemini');
    expect(screen.queryByTestId('wizard-base-url')).toBeNull();
    await userEvent.type(screen.getByTestId('wizard-name'), 'Gemini');
    await userEvent.type(screen.getByTestId('wizard-model'), 'gemini-2.5-flash');
    expect(screen.getByTestId('wizard-save')).toBeDisabled();
    await userEvent.click(screen.getByTestId('wizard-outside'));
    expect(screen.getByTestId('wizard-save')).toBeEnabled();
    await userEvent.click(screen.getByTestId('wizard-save'));
    await waitFor(() =>
      expect(posted('/llm-providers')[0]).toMatchObject({
        kind: 'gemini',
        base_url: null,
        allow_public_host: true,
        probe: true,
      }),
    );
  });

  it("shows the server's refusal when saving fails, and stays on the step", async () => {
    createStatus = 422;
    await toConnect('local');
    await userEvent.type(await screen.findByTestId('wizard-name'), 'x');
    await userEvent.type(screen.getByTestId('wizard-model'), 'm');
    await userEvent.click(screen.getByTestId('wizard-save'));
    await waitFor(() => expect(screen.getByTestId('wizard-error')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Connect and test it' })).toBeInTheDocument();
  });
});

describe('steps 3 and 4: roles and the review', () => {
  async function toRoles() {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-local'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.type(await screen.findByTestId('wizard-name'), 'New box');
    await userEvent.type(screen.getByTestId('wizard-model'), 'm');
    await userEvent.click(screen.getByTestId('wizard-save'));
    await screen.findByRole('heading', { name: /Which kinds of analysis should use New box/ });
  }

  it('makes the new connection the first choice for the ticked roles and keeps what was already there as fallbacks', async () => {
    await toRoles();
    for (const r of ROLES.filter((x) => x !== 'security' && x !== 'patch'))
      await userEvent.click(screen.getByTestId(`wizard-role-${r}`));
    await userEvent.click(screen.getByTestId('wizard-assign'));
    await screen.findByTestId('wizard-review');
    const put = requests.find((r) => r.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({
      local_only: false,
      roles: {
        // security had LM Studio; the new one (7) goes in front of it.
        security: [
          { provider_id: 7, model: null },
          { provider_id: 1, model: null },
        ],
        patch: [{ provider_id: 7, model: null }],
      },
    });
  });

  it("prints the server's local-only refusal, naming the role and connection", async () => {
    putStatus = 422;
    putBody = {
      title: 'Local-only is on, and a role would leave your network',
      detail:
        'Local-only is on: role "patch" would send to connection "Gemini", which is outside your network.',
      status: 422,
    };
    await toRoles();
    await userEvent.click(screen.getByTestId('wizard-assign'));
    expect(await screen.findByTestId('wizard-routing-detail')).toHaveTextContent(
      /role "patch" would send to connection "Gemini"/,
    );
    expect(screen.getByRole('heading', { name: /Which kinds of analysis/ })).toBeInTheDocument();
  });

  it('the review says, per role, what stays and what leaves - from what the server reports', async () => {
    routing = {
      local_only: false,
      roles: ROLES.map((role) => ({
        role,
        chain:
          role === 'security'
            ? [
                {
                  provider_id: 2,
                  provider_name: 'Gemini',
                  model: null,
                  host: cloud.host,
                  leaves_network: true,
                },
              ]
            : role === 'performance'
              ? [
                  {
                    provider_id: 1,
                    provider_name: 'LM Studio',
                    model: null,
                    host: lan.host,
                    leaves_network: false,
                  },
                ]
              : [],
      })),
      providers: [lan, cloud],
    };
    await toRoles();
    await userEvent.click(screen.getByTestId('wizard-skip'));
    expect(await screen.findByTestId('wizard-review-security')).toHaveTextContent(
      /Leaves.*generativelanguage\.googleapis\.com.*receives diffs/s,
    );
    expect(screen.getByTestId('wizard-review-performance')).toHaveTextContent(
      /Stays home\. Stays on your network\. Uses LM Studio/,
    );
    expect(screen.getByTestId('wizard-review-triage')).toHaveTextContent(
      /May leave your network: the shared pool includes Gemini/,
    );
    expect(screen.getByTestId('wizard-tier3')).toHaveTextContent(
      /Tier-3.*opts in.*blocks it entirely/s,
    );
  });
});
