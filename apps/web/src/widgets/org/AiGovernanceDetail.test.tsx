import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiGovernanceDetail, signalWords } from './AiGovernanceDetail.js';
import type { AiGovernance, AiGovernanceMeasure } from './contracts.js';

// W18-29. The governance screen renders W18-20's comparison in full: who wrote
// the changes INCLUDING the cohorts left out, each measure's sample in plain
// text, and a different sentence for each kind of blank. Signals, not grades.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    'data-testid': testId,
  }: {
    to: string;
    children: React.ReactNode;
    'data-testid'?: string;
  }) => (
    <a href={to} data-testid={testId}>
      {children}
    </a>
  ),
}));

const measure = (over: Partial<AiGovernanceMeasure> = {}): AiGovernanceMeasure => ({
  key: 'revert_rate',
  label: 'Revert rate',
  basis: 'M14 over each cohort’s non-merge commits',
  unit: 'ratio',
  ai: 0.05,
  human: 0.02,
  aiSample: 40,
  humanSample: 60,
  sampleUnit: 'commits',
  comparable: true,
  direction: 'higher',
  note: null,
  ...over,
});

const response = (over: Partial<AiGovernance> = {}): AiGovernance => ({
  window: '90d',
  aiShareCommits: 0.4,
  aiSharePrs: 0.25,
  counts: {
    aiCommits: 40,
    humanCommits: 60,
    aiPrs: 5,
    humanPrs: 15,
    automationCommits: 3,
    automationPrs: 1,
    unknownCommits: 7,
    unknownPrs: 0,
  },
  measures: [measure()],
  anyComparable: true,
  findingsMeasured: true,
  unattributedFindings: 0,
  patternsFingerprint: 'x',
  repoCount: 2,
  ...over,
});

function renderWith(data: AiGovernance | undefined, window = '90d', role = 'member') {
  useApiQuery.mockReset();
  useApiQuery.mockImplementation((d: { endpoint: string }) =>
    d.endpoint === '/me/context'
      ? { data: { role } }
      : { data, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  );
  return render(<AiGovernanceDetail window={window} search={{ repos: '1' }} />);
}

describe('AiGovernanceDetail (W18-29)', () => {
  it('shows the cohorts left out, not only the two compared', () => {
    renderWith(response());
    expect(screen.getByTestId('cohort-commits')).toHaveTextContent('Commits40 (40.0%)6010');
    expect(screen.getByTestId('governance-left-out')).toHaveTextContent(
      '3 commits by automation (dependency bots and the like) and 7 ingested before authorship signals were recorded — 91% of commits are classified',
    );
  });

  it('prints each measure with its basis and sample size, as words not grades', () => {
    const { container } = renderWith(response());
    const row = screen.getByTestId('governance-measure-revert_rate');
    expect(row).toHaveTextContent('M14 over each cohort’s non-merge commits');
    expect(row).toHaveTextContent('n=40 commits');
    expect(row).toHaveTextContent('higher for AI');
    expect(container.textContent).not.toMatch(/\bscore\b|\bgrade [A-F]\b/i);
  });

  it('a measure below its sample says so instead of a direction', () => {
    expect(signalWords(measure({ comparable: false, direction: null }))).toBe(
      'too small to compare',
    );
    expect(signalWords(measure({ note: 'Not measured: no review data' }))).toBe('not measured');
    expect(signalWords(measure({ direction: 'similar' }))).toBe('similar');
  });

  it('a custom range is UNAVAILABLE with a reason, and asks the API nothing', () => {
    renderWith(response(), '2026-01-01..2026-02-01');
    expect(screen.getByTestId('governance-unavailable')).toHaveTextContent(
      'computed over a preset window',
    );
    const call = useApiQuery.mock.calls.find(
      (c: unknown[]) => (c[0] as { endpoint: string }).endpoint === '/org/ai-governance',
    );
    expect((call?.[1] as { enabled: boolean } | undefined)?.enabled).toBe(false);
  });

  it('commits that predate the signals get their own sentence, not "no commits"', () => {
    renderWith(
      response({
        counts: { ...response().counts, aiCommits: 0, humanCommits: 0, unknownCommits: 12 },
      }),
    );
    expect(screen.getByTestId('governance-unclassifiable')).toHaveTextContent(
      'all 12 commits were ingested before Repo Pulse recorded co-author trailers',
    );
  });

  it('an empty window says there was nothing to compare', () => {
    renderWith(
      response({
        counts: { ...response().counts, aiCommits: 0, humanCommits: 0, unknownCommits: 0 },
      }),
    );
    expect(screen.getByTestId('governance-cohorts')).toHaveTextContent('No commits in this window');
    expect(screen.queryByTestId('governance-measures')).toBeNull();
  });

  it('only an admin is offered the pattern editor', () => {
    renderWith(response(), '90d', 'admin');
    expect(screen.getByTestId('governance-patterns-link')).toBeInTheDocument();
  });
});
