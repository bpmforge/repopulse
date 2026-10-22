import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskSecondOpinion, SecondOpinionAnswer } from './SecondOpinion.js';
import { ExternalTicket, TicketLink } from './ExternalTicket.js';
import { ExportFindings, exportHref } from './ExportFindings.js';
import { VerifiedFix } from './VerifiedFix.js';
import { reviewSummary, ticketLabel, type Finding } from './contracts.js';
import type { AiSuggestion, SecondOpinionInfo } from './aiContracts.js';

// W20-18: decisions of 2026-10-20 in the finding drawer and on Findings.
//   AI-14  a second opinion from another model, shown as agree/disagree; a hosted
//          model only on a Tier-3 opted-in repository, counted as a pass.
//   AI-77  "AI off" also stops verified-fix drafts a person asks for.
//   X-08   CSV/SARIF export of the current filters, and an external-ticket link.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
  mutations: [] as string[],
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: state.data, isLoading: false, isError: false }),
  useApiMutation: (d: { endpoint: string }) => {
    state.mutations.push(d.endpoint);
    return { mutate: state.mutate, isPending: false, error: null };
  },
  queryKeyFor: () => [],
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  state.data = undefined;
  state.mutate.mockReset();
  state.mutations = [];
});

const suggestion = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: 1,
  verdict: 'likely_false_positive',
  confidence: 4,
  rationale: 'The input is validated above.',
  citations: [{ file: 'src/a.ts', line: 3, text: 'x' }],
  vex: null,
  patch: { status: 'not_attempted', reason: null, diff: null },
  model: 'local-model',
  checklist_version: 'v1',
  route: { providerName: 'LM Studio', model: 'local-model', linkIndex: 0 },
  pass_id: 1,
  created_at: '2026-10-20T09:00:00Z',
  decision: null,
  decided_by: null,
  decided_at: null,
  ...over,
});

const info = (over: Partial<SecondOpinionInfo> = {}): SecondOpinionInfo => ({
  of: 1,
  local_only: false,
  tier3_opt_in: true,
  choices: [
    {
      provider_id: 7,
      provider_name: 'Hosted',
      host: 'api.example.com',
      model: 'hosted-model',
      leaves_network: true,
    },
  ],
  blocked: [],
  sends: 'the finding, its rule, and the stored lines of code around it (not the whole file)',
  passes_today: 3,
  passes_per_day: 10,
  latest: null,
  ...over,
});

describe('AI-14 second opinion', () => {
  it('says whether the second model agrees, and flags a disagreement', () => {
    const { rerender } = render(
      <SecondOpinionAnswer first={suggestion()} second={suggestion({ id: 2 })} />,
    );
    expect(screen.getByTestId('ai-second-opinion-2')).toHaveAttribute('data-agrees', 'true');
    expect(screen.getByTestId('ai-second-opinion-agreement')).toHaveTextContent('agrees');
    rerender(
      <SecondOpinionAnswer first={suggestion()} second={suggestion({ id: 2, verdict: 'real' })} />,
    );
    expect(screen.getByTestId('ai-second-opinion-agreement')).toHaveTextContent('disagrees');
    expect(screen.getByTestId('ai-second-opinion-disagree-note')).toBeInTheDocument();
  });

  it('names a hosted destination as leaving the network, counts it as a pass, and asks that model', () => {
    render(
      <AskSecondOpinion findingId={9} info={info()} isAdmin paused={undefined} invalidate={[]} />,
    );
    const dest = screen.getByTestId('ai-second-opinion-destination');
    expect(dest).toHaveAttribute('data-leaves', 'true');
    expect(dest).toHaveTextContent(/Leaves your network.*api\.example\.com.*opted in to Tier 3/s);
    expect(screen.getByTestId('ai-second-opinion-limit')).toHaveTextContent(
      'one of the 10 AI passes a day (3 used',
    );
    expect(state.mutations).toContain('/findings/{id}/ai-verdicts/{verdictId}/second-opinion');
    fireEvent.click(screen.getByTestId('ai-second-opinion-button'));
    expect(state.mutate).toHaveBeenCalledWith({ provider_id: 7 });
  });

  it('is refused on screen at the daily limit, for members, while AI is off, and with no other model', () => {
    const { rerender } = render(
      <AskSecondOpinion
        findingId={9}
        info={info({ passes_today: 10 })}
        isAdmin
        paused={undefined}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('ai-second-opinion-button')).toBeDisabled();
    rerender(
      <AskSecondOpinion
        findingId={9}
        info={info()}
        isAdmin={false}
        paused={undefined}
        invalidate={[]}
      />,
    );
    expect(screen.queryByTestId('ai-second-opinion-button')).toBeNull();
    expect(screen.getByTestId('ai-second-opinion-ask')).toHaveTextContent('An admin can ask');
    rerender(
      <AskSecondOpinion
        findingId={9}
        info={info()}
        isAdmin
        paused={{ paused: true, paused_by: 'ada', paused_at: null }}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('ai-second-opinion-paused')).toHaveTextContent(
      'switched off for this workspace by ada',
    );
    expect(screen.queryByTestId('ai-second-opinion-button')).toBeNull();
    rerender(
      <AskSecondOpinion
        findingId={9}
        info={info({
          tier3_opt_in: false,
          choices: [],
          blocked: [{ provider_name: 'Hosted', model: 'h', reason: 'not opted in to Tier 3' }],
        })}
        isAdmin
        paused={undefined}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('ai-second-opinion-none')).toHaveTextContent(
      'Hosted (not opted in to Tier 3)',
    );
  });

  it('follows a second opinion in flight and shows why the last one failed', () => {
    const { rerender } = render(
      <AskSecondOpinion
        findingId={9}
        info={info({
          latest: {
            id: 4,
            status: 'running',
            reason: null,
            created_at: '2026-10-20T09:00:00Z',
            destination: { model: 'hosted-model' },
          },
        })}
        isAdmin
        paused={undefined}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('ai-second-opinion-pending')).toHaveTextContent('hosted-model');
    expect(screen.queryByTestId('ai-second-opinion-button')).toBeNull();
    rerender(
      <AskSecondOpinion
        findingId={9}
        info={info({
          latest: { id: 4, status: 'failed', reason: 'No usable answer.', created_at: '' },
        })}
        isAdmin
        paused={undefined}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('ai-second-opinion-failed')).toHaveTextContent('No usable answer.');
  });
});

describe('AI-77 verified fix while AI is off', () => {
  it('says AI is off and offers no draft button', () => {
    state.data = {
      eligible: true,
      commit_sha: 'abc1234',
      patch: null,
      drafter: { local_only: false, leaves_network: false, destinations: [] },
      ai_paused: { paused: true, paused_by: 'ada', paused_at: null },
    };
    render(<VerifiedFix findingId={3} />);
    expect(screen.getByTestId('verified-fix-paused')).toHaveTextContent('no fix can be drafted');
    expect(screen.queryByTestId('verified-fix-draft')).toBeNull();
  });

  it('offers the draft button when AI is on', () => {
    state.data = {
      eligible: true,
      commit_sha: 'abc1234',
      patch: null,
      drafter: {
        local_only: false,
        leaves_network: false,
        destinations: [
          { provider_name: 'LM', host: '10.0.0.5', leaves_network: false, models: [] },
        ],
      },
      ai_paused: { paused: false, paused_by: null, paused_at: null },
    };
    render(<VerifiedFix findingId={3} />);
    expect(screen.queryByTestId('verified-fix-paused')).toBeNull();
    expect(screen.getByTestId('verified-fix-draft')).toBeInTheDocument();
  });
});

describe('X-08 export and external ticket', () => {
  it('exports the current filters as CSV and SARIF', () => {
    const filters = { status: 'active', repo_id: '4', q: 'lodash' };
    expect(exportHref('csv', filters)).toBe(
      '/api/v1/findings/export?status=active&repo_id=4&q=lodash&format=csv',
    );
    render(<ExportFindings filters={filters} total={240} />);
    expect(screen.getByTestId('findings-export-csv')).toHaveAttribute(
      'href',
      '/api/v1/findings/export?status=active&repo_id=4&q=lodash&format=csv',
    );
    expect(screen.getByTestId('findings-export-sarif').getAttribute('href')).toContain(
      'format=sarif',
    );
    expect(screen.getByTestId('findings-export-scope')).toHaveTextContent(
      '(240), not just this page',
    );
  });

  it('says the file is cut over the cap, and offers nothing for an empty list', () => {
    const { rerender } = render(<ExportFindings filters={{}} total={9000} />);
    expect(screen.getByTestId('findings-export-scope')).toHaveTextContent('stops at 5,000');
    rerender(<ExportFindings filters={{}} total={0} />);
    expect(screen.queryByTestId('findings-export-csv')).toBeNull();
  });

  it('links only http(s) tickets, opening in a new tab', () => {
    expect(ticketLabel('https://linear.app/acme/issue/ENG-142')).toBe('linear.app ENG-142');
    expect(ticketLabel('javascript:alert(1)')).toBeNull();
    expect(ticketLabel('not a url')).toBeNull();
    const { container, rerender } = render(<TicketLink url="javascript:alert(1)" />);
    expect(container.querySelector('a')).toBeNull();
    rerender(<TicketLink url="https://jira.example.com/browse/SEC-9" testId="t" />);
    const a = screen.getByTestId('t');
    expect(a).toHaveAttribute('href', 'https://jira.example.com/browse/SEC-9');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('sets, validates and removes the ticket link from the drawer', () => {
    const { unmount } = render(<ExternalTicket findingId={5} url={null} invalidate={[]} />);
    expect(state.mutations).toContain('/findings/{id}/external-ticket');
    fireEvent.click(screen.getByTestId('finding-ticket-edit'));
    fireEvent.change(screen.getByTestId('finding-ticket-input'), {
      target: { value: 'ftp://example.com/x' },
    });
    expect(screen.getByTestId('finding-ticket-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('finding-ticket-input'), {
      target: { value: ' https://linear.app/acme/issue/ENG-1 ' },
    });
    fireEvent.click(screen.getByTestId('finding-ticket-save'));
    expect(state.mutate).toHaveBeenCalledWith(
      { url: 'https://linear.app/acme/issue/ENG-1' },
      expect.anything(),
    );
    unmount();
    render(
      <ExternalTicket findingId={5} url="https://linear.app/acme/issue/ENG-1" invalidate={[]} />,
    );
    fireEvent.click(screen.getByTestId('finding-ticket-remove'));
    expect(state.mutate).toHaveBeenLastCalledWith({ url: null });
  });

  it('puts the ticket in the copied review summary', () => {
    const finding = {
      id: 5,
      repo: { id: 1, org: 'acme', name: 'api' },
      dimension: 'security',
      severity: 4,
      confidence: 4,
      title: 'SQL injection',
      file: 'src/db.ts',
      line_range: [3, 3],
      evidence: 'query(x)',
      recommendation: 'Bind parameters.',
      status: 'open',
      dismiss_reason: null,
      verify_status: 'unverified',
      external_ticket_url: 'https://linear.app/acme/issue/ENG-1',
    } as unknown as Finding;
    expect(reviewSummary(finding, [], 'https://rp.example')).toContain(
      'Ticket: https://linear.app/acme/issue/ENG-1',
    );
  });
});
