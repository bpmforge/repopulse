import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { AuditLog, LastChanged, detailSummary, eventLabel, type AuditPage } from './AuditLog.js';

// W20-10 (UX_TODO X-04): "who changed this, and when" was only in the
// container log.

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...rest
  }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const PAGE: AuditPage = {
  items: [
    {
      id: 40,
      event: 'admin.role.changed',
      actor_user_id: 1,
      actor_login: 'ada',
      ip: '10.0.0.1',
      detail: { targetUserId: 2, fromRole: 'member', toRole: 'admin' },
      occurred_at: '2026-10-18T09:00:00.000Z',
    },
    {
      id: 39,
      event: 'ops.backup.taken',
      actor_user_id: null,
      actor_login: null,
      ip: null,
      detail: {},
      occurred_at: '2026-10-18T03:00:00.000Z',
    },
  ],
  next_before: 39,
  events: ['admin.role.changed', 'ops.backup.taken'],
};

const urls: string[] = [];
let answer: { status: number; body: unknown };

beforeEach(() => {
  urls.length = 0;
  answer = { status: 200, body: PAGE };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  render(<QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>);
}

describe('AuditLog (W20-10)', () => {
  it('lists who did what and when, newest first, in words', async () => {
    renderWith(<AuditLog />);
    const row = await screen.findByTestId('audit-40');
    expect(row).toHaveTextContent('ada');
    expect(row).toHaveTextContent('Role changed');
    expect(row).toHaveTextContent('toRole: admin');
    expect(screen.getByTestId('audit-39')).toHaveTextContent('the system');
  });

  it('filters by event and offers a CSV export of the same filter', async () => {
    const user = userEvent.setup();
    renderWith(<AuditLog />);
    await screen.findByTestId('audit-40');
    await user.selectOptions(screen.getByTestId('audit-filter-event'), 'ops.backup.taken');
    await waitFor(() => expect(urls.some((u) => u.includes('event=ops.backup.taken'))).toBe(true));
    const href = screen.getByTestId('audit-export').getAttribute('href') ?? '';
    expect(href).toContain('format=csv');
    expect(href).toContain('event=ops.backup.taken');
  });

  it('shows older entries on request', async () => {
    const user = userEvent.setup();
    renderWith(<AuditLog />);
    await user.click(await screen.findByTestId('audit-more'));
    await waitFor(() => expect(urls.some((u) => u.includes('limit=100'))).toBe(true));
  });
});

describe('LastChanged (W20-10)', () => {
  it('names the last change, linking to the log', async () => {
    renderWith(<LastChanged events={['admin.role.changed']} testId="lc" />);
    expect(await screen.findByTestId('lc')).toHaveTextContent(
      /Last changed by ada on .* \(role changed\)/,
    );
    expect(urls[0]).toContain('limit=1');
  });

  it('renders nothing for a member (the log is admin-only)', async () => {
    answer = { status: 403, body: { title: 'Forbidden', status: 403 } };
    renderWith(<LastChanged events={['admin.role.changed']} testId="lc" />);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('lc')).not.toBeInTheDocument();
  });
});

describe('labels', () => {
  it('uses words for known events and the raw name otherwise', () => {
    expect(eventLabel('identity.linked')).toBe('Identity linked to a member');
    expect(eventLabel('something.new')).toBe('something.new');
    expect(detailSummary({ a: 1, b: null, c: '', d: { e: 2 } })).toBe('a: 1 · d: {"e":2}');
  });
});
