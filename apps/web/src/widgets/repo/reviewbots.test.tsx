import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createQueryClient } from '../../api/queryClient.js';
import { ReviewBots, formatHours, formatShare, lineDataNote } from './ReviewBots.js';
import type { RepoReviewBots } from './contracts.js';

// The AI Reviewers tab (W18-23): tools in the API's order, numbers with their
// parts, and every blank cell explained — never a zero standing in for "we do
// not have this", and never a grade.

const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

type Bot = RepoReviewBots['bots'][number];

function bot(over: Partial<Bot> & Pick<Bot, 'key' | 'name'>): Bot {
  return {
    logins_seen: ['x[bot]'],
    prs_reviewed: 10,
    reach: ratio(10, 40),
    reviews: 12,
    reviews_per_pr: ratio(12, 10),
    prs_with_line_data: 10,
    inline_comments: 31,
    comments_per_pr: ratio(31, 10),
    time_to_first: { median_hours: 0.1, p90_hours: 3, n: 10 },
    followed_by_change: { ...ratio(9, 20), pending: 4 },
    repeat_after_dismiss: { ...ratio(1, 3), dismissed_without_inline: 0 },
    ...over,
  };
}

const GITHUB: RepoReviewBots = {
  window: '30d',
  forge: 'github',
  line_data: 'available',
  prs_in_window: 40,
  prs_with_line_data: 40,
  other_bot_reviews: 2,
  bots: [
    bot({ key: 'coderabbit', name: 'CodeRabbit', logins_seen: ['coderabbitai[bot]'] }),
    // Fewer PRs, listed second anyway: the API's order is the registry's.
    bot({ key: 'bugbot', name: 'Cursor BugBot', prs_reviewed: 3, reach: ratio(3, 40) }),
  ],
};

let body: RepoReviewBots;

beforeEach(() => {
  body = GITHUB;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderTab() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos/$repoId/ai-reviewers',
    component: () => <ReviewBots repoId="7" window="30d" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/repos/7/ai-reviewers?window=30d'] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe('formatting', () => {
  it('shows the parts beside a share, and a dash for no data', () => {
    expect(formatShare(ratio(9, 20))).toBe('9 of 20 (45%)');
    expect(formatShare(ratio(0, 0))).toBe('—');
    expect(formatShare(null)).toBe('—');
  });
  it('picks a unit a person reads at a glance', () => {
    expect(formatHours(0.1)).toBe('6 min');
    expect(formatHours(3)).toBe('3.0 h');
    expect(formatHours(72)).toBe('3.0 d');
    expect(formatHours(null)).toBe('—');
  });
});

describe('lineDataNote', () => {
  it('names a forge without line anchors instead of guessing', () => {
    const note = lineDataNote({ ...GITHUB, forge: 'gitea', line_data: 'not_collected' });
    expect(note).toMatch(/^Gitea does not give RepoPulse line-level review-comment data/);
  });
  it('a refusal is not the same as unsupported', () => {
    expect(lineDataNote({ ...GITHUB, line_data: 'refused' })).toMatch(/refused/);
  });
  it('states partial coverage, and says nothing when coverage is complete', () => {
    expect(lineDataNote({ ...GITHUB, prs_with_line_data: 12 })).toMatch(/covers 12 of 40/);
    expect(lineDataNote(GITHUB)).toBeNull();
  });
});

describe('ReviewBots tab (W18-23)', () => {
  it('lists tools in the order the API sent, with their numbers', async () => {
    renderTab();
    const table = await screen.findByTestId('review-bots-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'review-bot-coderabbit',
      'review-bot-bugbot',
    ]);
    const rabbit = screen.getByTestId('review-bot-coderabbit');
    expect(rabbit).toHaveTextContent('10 of 40 (25%)');
    expect(rabbit).toHaveTextContent('3.1');
    expect(rabbit).toHaveTextContent('6 min · 3.0 h');
    expect(rabbit).toHaveTextContent('9 of 20 (45%)');
    expect(rabbit).toHaveTextContent('4 on open PRs, not counted yet');
    expect(screen.getByTestId('review-bots-other')).toHaveTextContent('2 review(s)');
    // Signals, not grades.
    expect(screen.getByTestId('review-bots-tab')).toHaveTextContent('compares tools, not people');
    expect(screen.getByTestId('review-bots-tab').textContent).not.toMatch(
      /\bgrade [A-E]\b|best|worst/i,
    );
  });

  it('on a forge without line data, comment columns are dashes with a reason', async () => {
    body = {
      ...GITHUB,
      forge: 'gitea',
      line_data: 'not_collected',
      prs_with_line_data: 0,
      bots: [
        bot({
          key: 'coderabbit',
          name: 'CodeRabbit',
          prs_with_line_data: 0,
          inline_comments: null,
          comments_per_pr: null,
          followed_by_change: null,
          repeat_after_dismiss: null,
        }),
      ],
    };
    renderTab();
    const row = await screen.findByTestId('review-bot-coderabbit');
    const cells = within(row).getAllByRole('cell');
    // Comments / PR, follow-up, repeat: dashes, each explained in words, not
    // a hover tooltip (W20-11, UX_TODO AI-47): a footnote mark, the reason for a
    // screen reader, and the notes listed under the table.
    for (const i of [2, 4, 5]) {
      expect(cells[i]).toHaveTextContent('—');
      expect(cells[i]).toHaveTextContent(/line-level/);
      expect(cells[i]!.querySelector('sup')).toHaveTextContent('1');
    }
    expect(screen.getByTestId('review-bots-blank-notes')).toHaveTextContent(
      /Blank because: .*line-level/,
    );
    expect(screen.getByTestId('review-bots-line-data')).toHaveTextContent(
      'Gitea does not give RepoPulse line-level review-comment data',
    );
  });

  // W20-11 (UX_TODO AI-15): this tab is about third-party bots; RepoPulse's own
  // AI review is elsewhere, and the tab says where.
  it('points to RepoPulse’s own AI review on the Security tab', async () => {
    renderTab();
    const own = await screen.findByTestId('review-bots-own-ai');
    expect(within(own).getByRole('link')).toHaveAttribute(
      'href',
      '/repos/7/security#ai-review-pass',
    );
  });

  it('says which tools it looks for when none were active', async () => {
    body = { ...GITHUB, bots: [], other_bot_reviews: 0 };
    renderTab();
    expect(
      await screen.findByText(/None of the AI review tools RepoPulse recognises/),
    ).toBeInTheDocument();
  });
});
