import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { AnalysisPolicy } from './AnalysisPolicy.js';

// W20-06 (UX_TODO AI-09, AI-10, AI-71, AI-72, AI-86). Admin → Analysis must say
// what is true: which models leave the network (by name), that Tier 2 is not
// "always local", that the old Tier-2 "auto" box did nothing, and that a Tier-3
// opt-in records a choice and sends nothing - after asking.

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

let body: unknown;
let patchStatus = 200;
const requests: { url: string; init: RequestInit | undefined }[] = [];

const repo = (over: Record<string, unknown> = {}) => ({
  id: 5,
  name: 'acme/api',
  tier2_auto: false,
  tier3_opt_in: false,
  egress: { calls: 0, bytes: 0, tokens_sent: 0 },
  ...over,
});

beforeEach(() => {
  requests.length = 0;
  patchStatus = 200;
  body = {
    gateway: {
      configured: true,
      provider_count: 3,
      off_network: true,
      off_network_names: ['Claude Code CLI', 'Gemini'],
      reason: null,
    },
    repos: [repo()],
    egress_log: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              patchStatus === 200 ? { id: 5 } : { title: 'Forbidden', status: patchStatus },
            ),
            {
              status: patchStatus,
              headers: {
                'content-type':
                  patchStatus === 200 ? 'application/json' : 'application/problem+json',
              },
            },
          ),
        );
      }
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

const renderIt = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AnalysisPolicy />
    </QueryClientProvider>,
  );
const patches = () =>
  requests.filter((r) => r.init?.method === 'PATCH').map((r) => JSON.parse(String(r.init?.body)));

describe('Admin → Analysis (W20-06)', () => {
  it('AI-86: names every off-network model instead of "one of which"', async () => {
    renderIt();
    const line = await screen.findByTestId('gateway-configured');
    expect(line).toHaveTextContent(
      /3 configured models\. Claude Code CLI and Gemini are outside your network/,
    );
    expect(line).not.toHaveTextContent(/one of which/);
  });

  it('AI-09: does not promise that Tier 2 stays on the network, and links to Routing', async () => {
    renderIt();
    const note = await screen.findByTestId('analysis-tiers-note');
    expect(note).not.toHaveTextContent(/nothing leaves your network/);
    expect(note).toHaveTextContent(/Tier 2 uses the models in Admin → Models/);
    expect(screen.getByRole('link', { name: 'Routing' })).toHaveAttribute('href', '/admin/models');
    expect(screen.queryByText('Tier 2 (local)')).toBeNull();
  });

  it('AI-71: the unwired Tier-2 "auto" box is gone, and a saved one is called out as doing nothing', async () => {
    body = { ...(body as object), repos: [repo({ tier2_auto: true })] };
    renderIt();
    const cell = await screen.findByTestId('tier2-5');
    expect(cell.querySelector('input')).toBeNull();
    expect(cell).toHaveTextContent(/saved but has no effect.*not built yet/s);
  });

  it('AI-10 and AI-72: opting in asks first, says what would go where and that Tier 3 sends nothing yet', async () => {
    renderIt();
    await userEvent.click(await screen.findByTestId('tier3-5'));
    expect(patches()).toHaveLength(0);
    const confirm = screen.getByTestId('tier3-confirm-5');
    expect(confirm).toHaveTextContent(
      /diff, the pull-request description and the review checklist to Anthropic/,
    );
    expect(confirm).toHaveTextContent(/egress audit/);
    expect(confirm).toHaveTextContent(/Tier 3 is not available yet.*sends nothing today/s);

    await userEvent.click(screen.getByTestId('tier3-confirm-cancel-5'));
    expect(screen.queryByTestId('tier3-confirm-5')).toBeNull();
    expect(patches()).toHaveLength(0);

    await userEvent.click(screen.getByTestId('tier3-5'));
    await userEvent.click(screen.getByTestId('tier3-confirm-do-5'));
    await waitFor(() => expect(patches()).toEqual([{ tier3_opt_in: true }]));
  });

  it('AI-72: an opted-in repository says nothing is sent, and opting out needs no confirmation', async () => {
    body = { ...(body as object), repos: [repo({ tier3_opt_in: true })] };
    renderIt();
    expect(await screen.findByTestId('analysis-repo-5')).toHaveTextContent(
      'opted in (nothing is sent yet)',
    );
    expect(screen.getByTestId('analysis-repo-5')).not.toHaveTextContent(/diffs may be sent/);
    await userEvent.click(screen.getByTestId('tier3-5'));
    await waitFor(() => expect(patches()).toEqual([{ tier3_opt_in: false }]));
  });

  it('AI-10: a refused change is shown', async () => {
    patchStatus = 403;
    body = { ...(body as object), repos: [repo({ tier3_opt_in: true })] };
    renderIt();
    await userEvent.click(await screen.findByTestId('tier3-5'));
    expect(await screen.findByTestId('tier3-error-5')).toBeInTheDocument();
  });
});
