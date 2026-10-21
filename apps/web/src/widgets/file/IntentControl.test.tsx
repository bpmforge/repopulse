import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { IntentControl, intentStatus } from './IntentControl.js';

// W20-20 (UX_TODO DSH-36/37): choose + note + Save, the saved note shown back,
// Clear, a visible error, and the intent's standing in dates.

let saved: Record<string, unknown> | null;
let failPut: boolean;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  saved = {
    id: 1,
    repo_id: 7,
    path: 'src/a.ts',
    intent: 'supervise',
    note: 'watch the parser',
    warn_after_months: 3,
    created_at: '2026-09-01T00:00:00.000Z',
  };
  failPut = false;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'PUT') {
        if (failPut) {
          return new Response(JSON.stringify({ title: 'Invalid intent', status: 400 }), {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          });
        }
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      if (method === 'DELETE') {
        saved = null;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: saved ? [saved] : [] }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderControl = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <IntentControl repoId={7} path="src/a.ts" />
    </QueryClientProvider>,
  );

describe('IntentControl', () => {
  it('shows the saved intent and note, and the hints as visible text', async () => {
    renderControl();
    expect(await screen.findByText(/watch the parser/)).toBeInTheDocument();
    expect(screen.getByTestId('intent-current')).toHaveTextContent('Supervise since 2026-09-01');
    expect(screen.getByTestId('intent-note')).toHaveValue('watch the parser');
    expect(screen.getByText(/hidden from hotspot lists, still counted/)).toBeVisible();
  });

  it('saves the note typed after choosing', async () => {
    renderControl();
    await screen.findByText(/watch the parser/);
    fireEvent.click(screen.getByTestId('intent-refactor'));
    fireEvent.change(screen.getByTestId('intent-note'), { target: { value: 'split it' } });
    fireEvent.click(screen.getByTestId('intent-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      repo_id: 7,
      path: 'src/a.ts',
      intent: 'refactor',
      note: 'split it',
    });
  });

  it('clears the intent', async () => {
    renderControl();
    await screen.findByText(/watch the parser/);
    fireEvent.click(screen.getByTestId('intent-clear'));
    await waitFor(() =>
      expect(screen.getByTestId('intent-current')).toHaveTextContent('No intent set'),
    );
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain('repo_id=7');
    expect(del?.url).toContain('path=src%2Fa.ts');
  });

  it('shows a failed save', async () => {
    failPut = true;
    renderControl();
    await screen.findByText(/watch the parser/);
    fireEvent.click(screen.getByTestId('intent-refactor'));
    fireEvent.click(screen.getByTestId('intent-save'));
    expect(await screen.findByTestId('intent-error')).toHaveTextContent('Invalid intent');
  });
});

describe('intentStatus (DSH-37)', () => {
  const row = {
    id: 1,
    repo_id: 7,
    path: 'a',
    intent: 'refactor',
    note: null,
    warn_after_months: 3,
    created_at: '2026-06-12T00:00:00.000Z',
  };

  it('counts down to a refactor review, then says it is past', () => {
    expect(intentStatus(row, new Date('2026-07-12T00:00:00.000Z'))).toBe(
      'Refactor since 2026-06-12 (30 days) — review due 2026-09-10, in 60 days',
    );
    expect(intentStatus(row, new Date('2026-10-01T00:00:00.000Z'))).toMatch(
      /past its 3-month review date/,
    );
  });

  it('gives other intents only their age', () => {
    expect(
      intentStatus({ ...row, intent: 'acknowledged' }, new Date('2026-06-13T00:00:00.000Z')),
    ).toBe('Acknowledged since 2026-06-12 (1 day)');
  });
});
