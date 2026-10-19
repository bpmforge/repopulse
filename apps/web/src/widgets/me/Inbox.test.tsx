import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Inbox, findingReason, type InboxResponse } from './Inbox.js';

// W20-10 (UX_TODO X-03): nothing told a human that a leaked secret, a KEV
// dependency or a failed scan needed them.

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    ...rest
  }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

let answer: InboxResponse;
const posts: string[] = [];

const FULL: InboxResponse = {
  since: '2026-10-12T00:00:00.000Z',
  first_look: true,
  unread: 3,
  findings_count: 2,
  failed_scans_count: 1,
  findings: [
    {
      id: 11,
      title: 'AWS key in config.ts',
      severity: 3,
      dimension: 'secrets',
      kev: false,
      repo_id: 1,
      repo: 'acme/api',
      at: '2026-10-18T00:00:00.000Z',
    },
    {
      id: 12,
      title: 'lodash prototype pollution',
      severity: 4,
      dimension: 'dependencies',
      kev: true,
      repo_id: 1,
      repo: 'acme/api',
      at: '2026-10-18T00:00:00.000Z',
    },
  ],
  failed_scans: [
    {
      id: 5,
      scanner: 'semgrep',
      error: 'rulepack missing',
      repo_id: 2,
      repo: 'acme/web',
      at: '2026-10-18T00:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  posts.length = 0;
  answer = FULL;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(url);
        answer = {
          ...FULL,
          first_look: false,
          unread: 0,
          findings_count: 0,
          failed_scans_count: 0,
          findings: [],
          failed_scans: [],
        };
        return Promise.resolve(
          new Response(JSON.stringify({ seen_at: 'now' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderInbox() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Inbox />
    </QueryClientProvider>,
  );
}

describe('Inbox (W20-10)', () => {
  it('shows an unread count, and lists each item with why it is there in words', async () => {
    const user = userEvent.setup();
    renderInbox();
    expect(await screen.findByTestId('inbox-count')).toHaveTextContent('3');
    await user.click(screen.getByTestId('inbox-button'));
    expect(screen.getByTestId('inbox-finding-11')).toHaveTextContent('Secret');
    expect(screen.getByTestId('inbox-finding-12')).toHaveTextContent('Known exploited');
    expect(screen.getByTestId('inbox-scan-5')).toHaveTextContent('semgrep on acme/web');
    expect(screen.getByTestId('inbox-since')).toHaveTextContent('from the last 7 days');
  });

  it('"Mark all as seen" clears the count', async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByTestId('inbox-count');
    await user.click(screen.getByTestId('inbox-button'));
    await user.click(screen.getByTestId('inbox-mark-seen'));
    await waitFor(() => expect(posts[0]).toContain('/me/inbox/seen'));
    await waitFor(() => expect(screen.queryByTestId('inbox-count')).not.toBeInTheDocument());
    expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
  });

  it('Escape closes the panel', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId('inbox-button'));
    expect(screen.getByTestId('inbox-panel')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('inbox-panel')).not.toBeInTheDocument();
  });
});

describe('findingReason', () => {
  it('names the reason, never colour alone', () => {
    expect(findingReason({ severity: 5, dimension: 'sast', kev: false })).toBe('Critical');
    expect(findingReason({ severity: 4, dimension: 'sast', kev: false })).toBe('High');
    expect(findingReason({ severity: 2, dimension: 'deps', kev: true })).toBe('Known exploited');
    expect(findingReason({ severity: 5, dimension: 'secrets', kev: true })).toBe('Secret');
  });
});
