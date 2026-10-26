import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrCiFindingsPanel, headSummary, type PrCiFindings } from './PrCiFindings.js';

// W20-15 (UX_TODO X-15). The PR page's review panel asked /findings?pr_number=,
// which missed the Semgrep incremental findings a CI check counts and kept
// findings a later push fixed. It now reads the CI's own answer.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const answer = (over: Partial<PrCiFindings> = {}): PrCiFindings => ({
  pull: { number: 7, head_sha: 'abc1234def' },
  head: {
    sha: 'abc1234def',
    scanned: true,
    scanners: [{ scanner_key: 'semgrep', scanned_at: '2026-10-15T00:00:00.000Z' }],
    pending: [],
    failed: [],
  },
  items: [
    {
      id: 41,
      rule_id: 'bpm-sql-injection',
      scanner_key: 'semgrep',
      dimension: 'sast',
      severity: 5,
      title: 'SQL built from request input',
      file: 'src/db.ts',
      line_start: 12,
      line_end: 12,
      status: 'open',
      introduced_by_pr: true,
      seen_at_head: true,
    },
  ],
  next_cursor: null,
  ...over,
});

beforeEach(() => {
  useApiQuery.mockReset();
  useApiQuery.mockReturnValue({ data: answer(), isLoading: false, isError: false });
});

describe('New on this PR (W20-15, UX_TODO X-15)', () => {
  it('reads the same answer the CI check reads, new findings only by default', () => {
    render(<PrCiFindingsPanel repoId="3" number="7" />);
    expect(useApiQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpoint: '/repos/{id}/pulls/{number}/findings',
        path: { id: '3', number: '7' },
        query: { new: 'true' },
      }),
    );
    expect(screen.getByText('New on this PR (what your CI sees)')).toBeInTheDocument();
    expect(screen.getByText('SQL built from request input')).toBeInTheDocument();
    expect(screen.getByText('src/db.ts:12')).toBeInTheDocument();
  });

  it('shows the head commit and which scanners have read it', () => {
    render(<PrCiFindingsPanel repoId="3" number="7" />);
    expect(screen.getByTestId('pr-ci-head')).toHaveTextContent(
      'Head commit abc1234 scanned by semgrep.',
    );
  });

  it('says when the head is not fully scanned, naming what is still running', () => {
    useApiQuery.mockReturnValue({
      data: answer({
        head: { sha: 'abc1234def', scanned: false, scanners: [], pending: ['secrets'], failed: [] },
      }),
      isLoading: false,
      isError: false,
    });
    render(<PrCiFindingsPanel repoId="3" number="7" />);
    expect(screen.getByTestId('pr-ci-head')).toHaveTextContent(
      /not scanned yet\. Still scanning: secrets\..*a CI check would wait/,
    );
  });

  it('can include pre-existing findings in touched files, and marks them', () => {
    render(<PrCiFindingsPanel repoId="3" number="7" />);
    useApiQuery.mockReturnValue({
      data: answer({
        items: [{ ...answer().items[0]!, id: 9, title: 'Old weak hash', introduced_by_pr: false }],
      }),
      isLoading: false,
      isError: false,
    });
    fireEvent.click(screen.getByTestId('pr-ci-preexisting'));
    expect(useApiQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: { new: 'false' } }),
    );
    expect(screen.getByText('(pre-existing)')).toBeInTheDocument();
  });

  it('names failed scanners in the head line', () => {
    expect(
      headSummary({ sha: 'abcdef123', scanned: true, scanners: [], failed: ['secrets'] }),
    ).toBe('Head commit abcdef1 not scanned yet. Failed at this head: secrets.');
  });

  // W21-01: a ref that is not a commit id is shown whole, never cut to a word.
  it('shows a non-hex head ref whole rather than cutting it at seven characters', () => {
    expect(headSummary({ sha: 'payments-pr4-head', scanned: false, scanners: [] })).toBe(
      'Head commit payments-pr4-head not scanned yet.',
    );
  });
});
