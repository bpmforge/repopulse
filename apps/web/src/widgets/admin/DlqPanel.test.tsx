import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DlqPanel, type DlqRow } from './DlqPanel.js';
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
