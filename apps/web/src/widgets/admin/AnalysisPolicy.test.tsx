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
      if (init?.method === 'PATCH' || init?.method === 'PUT') {
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

describe('Admin → Analysis egress audit (W20-11)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 1,
    repo_id: 5,
    repo: 'acme/api',
    model: 'gemini-2.5-flash',
    bytes_sent: 2048,
    tokens_sent: 500,
    tokens_received: 40,
    outcome: 'succeeded',
    host: 'generativelanguage.googleapis.com',
    tier: 2,
    initiator: 'scheduled',
    content_sha256: 'abc',
    sent_at: '2026-10-18T10:00:00Z',
    ...over,
  });

  // UX_TODO AI-29 (partial), AI-79: one row per request, with repository and outcome.
  it('shows the repository, destination and outcome of each request, and refused calls apart', async () => {
    body = {
      ...(body as object),
      repos: [repo({ egress: { calls: 1, bytes: 2048, tokens_sent: 500, refused: 2 } })],
      egress_log: [row(), row({ id: 2, outcome: 'denied', bytes_sent: 0 })],
      egress_total: 2,
      egress_next_cursor: null,
    };
    renderIt();
    expect(await screen.findByTestId('egress-row-1')).toHaveTextContent('acme/api');
    expect(screen.getByTestId('egress-row-1')).toHaveTextContent(
      'generativelanguage.googleapis.com',
    );
    expect(screen.getByTestId('egress-outcome-1')).toHaveTextContent('sent, answered');
    expect(screen.getByTestId('egress-outcome-2')).toHaveTextContent(
      'refused by policy, nothing sent',
    );
    expect(screen.getByTestId('egress-sum-5')).toHaveTextContent('1 call · 2 KB');
    expect(screen.getByTestId('egress-sum-5')).toHaveTextContent('2 refused by policy');
    expect(screen.getByTestId('egress-count')).toHaveTextContent('Showing 2 of 2 requests');
  });

  // UX_TODO AI-80 (partial): filter by repository, and page back.
  it('filters the log by repository and pages to older rows', async () => {
    body = {
      ...(body as object),
      repos: [repo()],
      egress_log: [row()],
      egress_total: 51,
      egress_next_cursor: '1',
    };
    renderIt();
    await screen.findByTestId('egress-row-1');
    await userEvent.click(screen.getByTestId('egress-older'));
    await waitFor(() => expect(requests.some((r) => r.url.includes('before=1'))).toBe(true));
    await userEvent.selectOptions(screen.getByTestId('egress-filter-repo'), '5');
    await waitFor(() =>
      expect(requests.some((r) => r.url.includes('repo_id=5') && !r.url.includes('before='))).toBe(
        true,
      ),
    );
  });

  // W20-16 (UX_TODO AI-08): what hosted calls cost, honestly.
  it('AI-08: shows spend per month and model, priced where a price was entered', async () => {
    body = {
      ...(body as object),
      spend: {
        months: 6,
        prices: { 'gpt-x': { input_per_mtok: 3, output_per_mtok: 10 } },
        rows: [
          {
            month: '2026-10',
            model: 'gpt-x',
            host: 'api.example.com',
            calls: 4,
            tokens_sent: 2_000_000,
            tokens_received: 500_000,
            unmeasured_calls: 0,
            estimated_usd: 11,
          },
          {
            month: '2026-10',
            model: 'other',
            host: 'api.other.com',
            calls: 1,
            tokens_sent: 10,
            tokens_received: 5,
            unmeasured_calls: 1,
            estimated_usd: null,
          },
        ],
      },
    };
    renderIt();
    expect(await screen.findByTestId('ai-spend-estimate-2026-10-gpt-x')).toHaveTextContent('$11');
    expect(screen.getByTestId('ai-spend-estimate-2026-10-other')).toHaveTextContent(
      'no price entered',
    );
    expect(screen.getByTestId('ai-spend-month-2026-10')).toHaveTextContent(
      /\$11.*\+ unpriced models/,
    );
    await userEvent.click(screen.getByText(/Prices \(1 of 2 models priced\)/));
    await userEvent.type(screen.getByTestId('price-input-other'), '1');
    await userEvent.type(screen.getByTestId('price-output-other'), '2');
    await userEvent.click(screen.getByTestId('price-save-other'));
    await waitFor(() =>
      expect(
        requests
          .filter((r) => r.init?.method === 'PUT')
          .map((r) => JSON.parse(String(r.init?.body))),
      ).toEqual([{ model: 'other', input_per_mtok: 1, output_per_mtok: 2 }]),
    );
  });
});
