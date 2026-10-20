import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { ModelsWizard } from './ModelsWizard.js';

// The "What next" links (W20-11, UX_TODO AI-23) render as plain anchors here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    hash,
    children,
    search: _search,
    params: _params,
    ...rest
  }: {
    to: string;
    hash?: string;
    search?: unknown;
    params?: unknown;
    children: ReactNode;
  }) => (
    <a href={`${to}${hash ? `#${hash}` : ''}`} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * Save without pressing Test first. W20-11 (UX_TODO AI-18): Save is no longer
 * greyed out until a test passes; an untested save asks to confirm instead.
 */
async function saveUntested() {
  await userEvent.click(screen.getByTestId('wizard-save'));
  await userEvent.click(await screen.findByTestId('wizard-save-anyway'));
}

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
let createdId: number | null = 7;
const requests: { url: string; init: RequestInit | undefined }[] = [];

const json = (b: unknown, status = 200) =>
  new Response(b === null ? null : JSON.stringify(b), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

beforeEach(() => {
  requests.length = 0;
  createStatus = 201;
  createdId = 7;
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
        return Promise.resolve(json({ id: createdId, capabilities: null }, createStatus));
      if (url.includes('/kinds')) return Promise.resolve(json(KINDS));
      if (url.includes('/claude-cli'))
        return Promise.resolve(
          json({
            statement: { version: 'v1', sha256: 'x', title: 'Using your own CLI', points: [] },
            accepted: null,
            cli: { found: false, version: null, reportsLoggedIn: false, reason: 'not installed' },
          }),
        );
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
    // W20-11 (UX_TODO AI-19): Gemini first, the cheapest way to start.
    expect(options).toEqual([
      'Google Gemini (API key)',
      'Anthropic (Claude API)',
      'OpenAI-compatible endpoint',
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
    await saveUntested();
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
    await saveUntested();
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
    await saveUntested();
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

  it('AI-55: a create that returned no id says so and points to Routing, instead of doing nothing', async () => {
    createdId = null;
    await toRoles();
    await userEvent.click(screen.getByTestId('wizard-assign'));
    expect(await screen.findByTestId('wizard-assign-noid')).toHaveTextContent(/Routing section/);
    expect(requests.some((r) => r.init?.method === 'PUT')).toBe(false);
  });

  it('AI-54: finished steps say "(done)" to a screen reader, and Choose roles can be gone back to', async () => {
    await toRoles();
    await userEvent.click(screen.getByTestId('wizard-skip'));
    await screen.findByTestId('wizard-review');
    const steps = screen.getByTestId('wizard-steps');
    expect(steps).toHaveTextContent('1. Where it runs ✓ (done)');
    // The connection is saved: going back to step 1 or 2 would add another.
    expect(screen.queryByTestId('wizard-step-0')).toBeNull();
    await userEvent.click(screen.getByTestId('wizard-step-2'));
    expect(screen.getByRole('heading', { name: /Which kinds of analysis/ })).toBeInTheDocument();
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
    // W20-06 (UX_TODO AI-72): Tier 3 is described as what it is today.
    expect(screen.getByTestId('wizard-tier3')).toHaveTextContent(
      /used for every repository.*Tier 3.*not available yet.*sends nothing/s,
    );
  });

  // W20-06 (UX_TODO AI-07): a vendor key must not become first choice for every
  // kind of analysis because the boxes were pre-ticked.
  it('a hosted vendor starts with no role ticked, and says what ticking one means', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-hosted'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.selectOptions(await screen.findByTestId('wizard-kind'), 'gemini');
    await userEvent.type(screen.getByTestId('wizard-name'), 'Gemini');
    await userEvent.type(screen.getByTestId('wizard-model'), 'gemini-2.5-flash');
    await userEvent.click(screen.getByTestId('wizard-outside'));
    await saveUntested();
    await screen.findByRole('heading', { name: /Which kinds of analysis should use Gemini/ });
    for (const r of ROLES) expect(screen.getByTestId(`wizard-role-${r}`)).not.toBeChecked();
    expect(screen.getByTestId('wizard-roles-none-ticked')).toHaveTextContent(
      /every role you tick sends diffs.*to this vendor/s,
    );
    await userEvent.click(screen.getByTestId('wizard-roles-all'));
    for (const r of ROLES) expect(screen.getByTestId(`wizard-role-${r}`)).toBeChecked();
  });

  // W20-06 (UX_TODO AI-06): a gateway on a LAN IP is not "Stays home".
  it('a connection added as a gateway is reviewed as "through a gateway", not "stays home"', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-proxy'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.type(await screen.findByTestId('wizard-name'), 'LiteLLM');
    await userEvent.type(screen.getByTestId('wizard-base-url'), 'http://10.0.0.7:4000/v1');
    await userEvent.type(screen.getByTestId('wizard-model'), 'm');
    await saveUntested();
    await screen.findByRole('heading', { name: /Which kinds of analysis should use LiteLLM/ });
    routing = {
      local_only: false,
      roles: ROLES.map((role) => ({
        role,
        chain:
          role === 'security'
            ? [
                {
                  provider_id: 7,
                  provider_name: 'LiteLLM',
                  model: null,
                  host: '10.0.0.7:4000',
                  leaves_network: false,
                },
              ]
            : [],
      })),
      providers: [
        { id: 7, name: 'LiteLLM', enabled: true, host: '10.0.0.7:4000', leaves_network: false },
      ],
    };
    await userEvent.click(screen.getByTestId('wizard-role-security'));
    await userEvent.click(screen.getByTestId('wizard-assign'));
    const row = await screen.findByTestId('wizard-review-security');
    await waitFor(() => expect(row).toHaveTextContent(/Through a gateway/));
    expect(row).toHaveTextContent(/stays on your network only if the gateway does not forward it/);
    expect(row).not.toHaveTextContent(/Stays home/);
  });

  // W20-06 (UX_TODO AI-58): warned before anything is typed.
  it('warns at "Where it runs" that Local only will block a vendor or gateway', async () => {
    routing = { ...(routing as object), local_only: true };
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-hosted'));
    expect(await screen.findByTestId('wizard-local-only-warning')).toHaveTextContent(
      /Local only is on.*will not be used until Local only is turned off/s,
    );
    await userEvent.click(screen.getByTestId('wizard-where-local'));
    expect(screen.queryByTestId('wizard-local-only-warning')).toBeNull();
  });
});

// W20-06 (UX_TODO AI-57): in a container, localhost is the container itself.
describe('presets in a container install', () => {
  it('fills a machine-IP placeholder, focuses it, shows the preset note, and explains a localhost failure', async () => {
    const original = KINDS.presets[0]!.note;
    KINDS.presets[0]!.note = 'Start the local server in LM Studio and load a model.';
    (KINDS as { in_container?: boolean }).in_container = true;
    try {
      renderIt();
      await userEvent.click(await screen.findByTestId('wizard-where-local'));
      await userEvent.click(screen.getByTestId('wizard-next-0'));
      await userEvent.click(await screen.findByTestId('wizard-preset-lmstudio'));
      const field = screen.getByTestId('wizard-base-url');
      expect(field).toHaveValue('http://<machine-ip>:1234/v1');
      await waitFor(() => expect(field).toHaveFocus());
      expect(screen.getByTestId('wizard-preset-note')).toHaveTextContent(
        /Start the local server in LM Studio.*Replace <machine-ip>/s,
      );

      testBody = {
        ok: false,
        stage: 'transport',
        detail: 'connect ECONNREFUSED 127.0.0.1:1234',
        hint: 'RepoPulse runs in a container, so "localhost" here means the container itself.',
      };
      await userEvent.type(screen.getByTestId('wizard-model'), 'm');
      await userEvent.click(screen.getByTestId('wizard-test'));
      expect(await screen.findByTestId('wizard-test-hint-localhost')).toHaveTextContent(
        /means the container itself/,
      );
    } finally {
      KINDS.presets[0]!.note = original;
      delete (KINDS as { in_container?: boolean }).in_container;
    }
  });
});

describe('W20-11 friction fixes', () => {
  // UX_TODO AI-18: Save was greyed out until a test passed, with no way past a
  // flaky test; now an untested save asks first.
  it('an untested save asks to confirm; a tested one saves straight away', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-local'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.type(await screen.findByTestId('wizard-name'), 'Box');
    await userEvent.type(screen.getByTestId('wizard-model'), 'm');
    await userEvent.click(screen.getByTestId('wizard-save'));
    expect(screen.getByTestId('wizard-confirm-untested')).toBeInTheDocument();
    expect(posted('/llm-providers')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('wizard-confirm-cancel'));
    expect(screen.queryByTestId('wizard-confirm-untested')).toBeNull();
    await userEvent.click(screen.getByTestId('wizard-test'));
    await screen.findByTestId('wizard-test-result');
    await userEvent.click(screen.getByTestId('wizard-save'));
    expect(screen.queryByTestId('wizard-confirm-untested')).toBeNull();
    await waitFor(() => expect(posted('/llm-providers')).toHaveLength(1));
  });

  // UX_TODO AI-19: say where the key comes from.
  it('links to where a hosted vendor key is made', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-hosted'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    expect(await screen.findByTestId('wizard-kind')).toHaveValue('gemini');
    expect(screen.getByTestId('wizard-key-help')).toHaveAttribute(
      'href',
      'https://aistudio.google.com/apikey',
    );
  });

  // UX_TODO AI-21: a failed test says what to do, not only what went wrong.
  it('a refused connection comes with a next step', async () => {
    testBody = { ok: false, stage: 'transport', detail: 'connect ECONNREFUSED 10.0.0.5:1234' };
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-local'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.type(await screen.findByTestId('wizard-model'), 'm');
    await userEvent.click(screen.getByTestId('wizard-test'));
    expect(await screen.findByTestId('wizard-test-next-step')).toHaveTextContent(
      /Nothing answered at that address/,
    );
  });

  // UX_TODO AI-17: the customer-supplied CLI is offered as its own choice.
  it('offers the customer-supplied CLI as its own choice, with no API key field', async () => {
    renderIt();
    await screen.findByTestId('wizard-where-cli');
    expect(screen.getByText(/off until an admin accepts a statement/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-where-cli'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    expect(await screen.findByTestId('wizard-cli-no-key')).toBeInTheDocument();
  });

  // UX_TODO AI-68: the wizard ends by saying how a first review is run.
  it('the review ends with what to do next', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('wizard-where-local'));
    await userEvent.click(screen.getByTestId('wizard-next-0'));
    await userEvent.type(await screen.findByTestId('wizard-name'), 'New box');
    await userEvent.type(screen.getByTestId('wizard-model'), 'm');
    await saveUntested();
    await screen.findByRole('heading', { name: /Which kinds of analysis should use New box/ });
    await userEvent.click(screen.getByTestId('wizard-skip'));
    const next = await screen.findByTestId('wizard-what-next');
    expect(within(next).getByText('Repositories')).toHaveAttribute('href', '/repos');
    expect(within(next).getByText('Settings → Analysis')).toHaveAttribute(
      'href',
      '/admin/analysis',
    );
  });
});
