import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiGovernanceCard } from './AiGovernanceCard.js';
import type { AiGovernance, AiGovernanceMeasure } from './contracts.js';
import { getWidget } from '../../components/widget/WidgetRegistry.js';
import { orgWidgets } from './OrgOverview.js';

// W18-20. The tile renders the server's comparison and decides nothing; what it
// must never do is print a direction for a sample the server called too small,
// grade anything, or forward the per-person filter.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const measure = (over: Partial<AiGovernanceMeasure>): AiGovernanceMeasure => ({
  key: 'revert_rate',
  label: 'Revert rate',
  basis: 'M14',
  unit: 'ratio',
  ai: 0.2,
  human: 0.04,
  aiSample: 40,
  humanSample: 60,
  sampleUnit: 'commits',
  comparable: true,
  direction: 'higher',
  note: null,
  ...over,
});

const response = (over: Partial<AiGovernance> = {}): AiGovernance => ({
  window: '30d',
  aiShareCommits: 0.4,
  aiSharePrs: 0.25,
  counts: {
    aiCommits: 40,
    humanCommits: 60,
    aiPrs: 5,
    humanPrs: 15,
    automationCommits: 3,
    automationPrs: 1,
    unknownCommits: 0,
    unknownPrs: 0,
  },
  measures: [
    measure({}),
    measure({
      key: 'rework_14d',
      label: 'Rework within 14 days',
      comparable: false,
      direction: null,
      aiSample: 300,
      note: 'Too small to compare: 300 AI-authored and 4000 human lines changed; at least 1000 of each are needed.',
    }),
  ],
  anyComparable: true,
  findingsMeasured: true,
  unattributedFindings: 0,
  patternsFingerprint: 'abcd1234',
  repoCount: 3,
  ...over,
});

function renderWith(data: AiGovernance | undefined, role: 'admin' | 'member' = 'member') {
  useApiQuery.mockImplementation((d: { endpoint: string }) =>
    d.endpoint === '/me/context'
      ? { data: { role } }
      : { data, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  );
  return render(<AiGovernanceCard window="30d" search={{ repos: '1,2', person: 'ann' }} />);
}

describe('AiGovernanceCard (W18-20)', () => {
  it('shows the AI share and a signal word only where the server says the sample is comparable', () => {
    renderWith(response());
    expect(screen.getByTestId('ai-share-commits')).toHaveTextContent('40.0%');
    expect(screen.getByTestId('ai-share-commits')).toHaveTextContent('40 of 100');
    const revert = screen.getByTestId('ai-measure-revert_rate');
    expect(within(revert).getByText('higher for AI')).toBeInTheDocument();
    const rework = screen.getByTestId('ai-measure-rework_14d');
    expect(rework).toHaveAttribute('data-comparable', 'false');
    expect(within(rework).getByText('too small to compare')).toBeInTheDocument();
  });

  // W20-11 (UX_TODO AI-49): methods and notes in text, not only in tooltips.
  it('lists how each measure is computed, with its note, in a disclosure', () => {
    renderWith(response());
    const methods = screen.getByTestId('ai-governance-methods');
    expect(methods.tagName).toBe('DETAILS');
    expect(methods).toHaveTextContent('Revert rate');
    expect(methods).toHaveTextContent('M14');
    expect(methods).toHaveTextContent(/at least 1000 of each are needed/);
  });

  it('says plainly when nothing is comparable', () => {
    renderWith(response({ anyComparable: false }));
    expect(screen.getByTestId('ai-governance-small-sample')).toHaveTextContent(
      /Too small a sample to compare/,
    );
  });

  it('never grades: no letters, no better/worse', () => {
    renderWith(response());
    const text = screen.getByTestId('ai-governance-body').textContent ?? '';
    expect(text).not.toMatch(/\b(better|worse|grade [A-F])\b/i);
    expect(text).toMatch(/Signals, not grades/);
  });

  it('forwards the repo filter but never the per-person one', () => {
    renderWith(response());
    const call = useApiQuery.mock.calls.find(
      (c) => (c[0] as { endpoint: string }).endpoint === '/org/ai-governance',
    )!;
    expect((call[0] as { query: Record<string, string> }).query).toEqual({
      window: '30d',
      repos: '1,2',
    });
  });

  it('an unclassifiable window is an empty state that says why', () => {
    renderWith(
      response({
        aiShareCommits: null,
        counts: { ...response().counts, aiCommits: 0, humanCommits: 0, unknownCommits: 12 },
      }),
    );
    expect(
      screen.getByText(/12 commits were ingested before authorship signals/),
    ).toBeInTheDocument();
  });

  it('shows the patterns link to admins only', () => {
    renderWith(response(), 'member');
    expect(screen.queryByTestId('ai-governance-patterns')).toBeNull();
    renderWith(response(), 'admin');
    expect(screen.getByTestId('ai-governance-patterns')).toBeInTheDocument();
  });

  it('links to the full governance screen (W18-29)', () => {
    renderWith(response());
    expect(screen.getByTestId('ai-governance-details')).toHaveAttribute('href', '/governance');
  });

  it('is registered and placed on the org overview', () => {
    expect(getWidget('ai-governance')).toBeDefined();
    expect(orgWidgets('30d', {}).map((w) => w.type)).toContain('ai-governance');
  });
});
