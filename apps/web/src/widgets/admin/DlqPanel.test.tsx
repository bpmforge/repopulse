import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DlqPanel, targetText, type DlqRow } from './DlqPanel.js';
import { errorPreview } from './ErrorDetails.js';

// W20-14 (UX_TODO ADM-16, INS-45).

const LONG = `ForgeHttpError: HTTP 502 from the forge while listing pull requests ${'y'.repeat(100)} TAIL`;
const ROWS: DlqRow[] = [
  {
    id: 1,
    queue: 'backfill',
    job_id: 'job-1',
    error: LONG,
    failed_at: '2026-10-01T10:00:00Z',
    replayed_at: null,
  },
  {
    id: 2,
    queue: 'snapshot',
    job_id: 'job-2',
    error: 'short',
    failed_at: '2026-10-01T10:00:00Z',
    replayed_at: '2026-10-02T10:00:00Z',
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: ROWS }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('DlqPanel (W20-14)', () => {
  it('ADM-16: a long error is an expandable disclosure holding the full text', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DlqPanel />
      </QueryClientProvider>,
    );
    const details = await screen.findByTestId('dlq-error-1');
    expect(details.tagName).toBe('DETAILS');
    expect(details).toHaveTextContent('TAIL');
    expect(screen.getByTestId('dlq-error-2').tagName).toBe('SPAN');
    expect(errorPreview('a'.repeat(100))).toHaveLength(61);
  });

  it('INS-45: a replayed row says when, and the button offers to replay again', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DlqPanel />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('dlq-replayed-2')).toHaveTextContent(/^Replayed /);
    expect(screen.getByTestId('dlq-replay-2')).toHaveTextContent('Replay again');
    expect(screen.getByTestId('dlq-replay-1')).toHaveTextContent(/^Replay$/);
    expect(screen.getByTestId('dlq-replay-1').className).toMatch(/focus-visible:outline/);
  });
});

// W20-22 (UX_TODO ADM-53): what each job was for, and a way out for one that
// can never succeed.
describe('DlqPanel targets and discard (W20-22)', () => {
  it('names the repository and the item, and says when the repository is gone', () => {
    expect(
      targetText({
        target: { repo_id: 4, repo: 'acme/api', repo_removed: false, detail: 'pull request #12' },
      }),
    ).toBe('acme/api · pull request #12');
    expect(
      targetText({ target: { repo_id: 9, repo: null, repo_removed: true, detail: 'commits' } }),
    ).toBe('repository 9 (removed) · commits');
    expect(targetText({})).toBe('—');
  });

  it('discards with a reason, prefilled for a removed repository, and hides Replay', async () => {
    const calls: { url: string; body: string; method: string }[] = [];
    const rows: DlqRow[] = [
      {
        id: 7,
        queue: 'ingest.backfill',
        job_id: 'job-7',
        error: 'insert violates foreign key',
        failed_at: '2026-10-01T10:00:00Z',
        replayed_at: null,
        target: { repo_id: 9, repo: null, repo_removed: true, detail: null },
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: String(init?.body),
          method: init?.method ?? 'GET',
        });
        const body =
          (init?.method ?? 'GET') === 'GET' ? { items: rows } : { id: 7, discarded: true };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DlqPanel />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('dlq-target-7')).toHaveTextContent('(removed)');
    expect(screen.queryByTestId('dlq-replay-7')).toBeNull();
    fireEvent.click(screen.getByTestId('dlq-discard-7'));
    expect(screen.getByTestId('dlq-discard-reason-7')).toHaveValue('Its repository was removed');
    fireEvent.click(screen.getByTestId('dlq-discard-do-7'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/admin/dlq/7/discard');
    expect(JSON.parse(post.body)).toEqual({ reason: 'Its repository was removed' });
  });
});
