import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemStatus, type SystemStatusResponse } from './SystemStatus.js';

// W17-08. The widget's job is to make a broken install impossible to mistake
// for a healthy one, so the tests that matter are the failure ones.

// The router Link is replaced by a plain anchor, and it must FORWARD the rest
// of the props: an earlier version dropped data-testid, and the link assertions
// then failed for a reason that had nothing to do with the component.
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

const ready: SystemStatusResponse = {
  checkedAt: new Date().toISOString(),
  overall: 'unavailable',
  components: [
    {
      id: 'database',
      label: 'Database',
      state: 'ready',
      reason: 'Postgres is answering.',
      lastSuccessAt: new Date().toISOString(),
      action: null,
    },
    {
      id: 'worker',
      label: 'Background worker',
      state: 'unavailable',
      reason: 'No worker has published a heartbeat in the last minute.',
      lastSuccessAt: null,
      action: { label: 'Setup checklist', href: '/setup' },
    },
    {
      id: 'models',
      label: 'AI review models',
      state: 'setup_needed',
      reason: 'No model configured. This is OPTIONAL — delivery metrics still work.',
      lastSuccessAt: null,
      action: { label: 'Models', href: '/admin/models' },
    },
  ],
};

function renderWidget() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SystemStatus />
    </QueryClientProvider>,
  );
}

describe('SystemStatus (W17-08)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respond(body: unknown, ok = true, status = 200): void {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response);
  }

  it('shows each component with its state IN WORDS, not colour alone', async () => {
    respond(ready);
    renderWidget();

    await waitFor(() => expect(screen.getByTestId('system-status-list')).toBeInTheDocument());
    // The state name is rendered, so the meaning survives greyscale and a
    // screenshot pasted into a ticket (WCAG 1.4.1).
    expect(screen.getByTestId('system-state-database')).toHaveTextContent('Ready');
    expect(screen.getByTestId('system-state-worker')).toHaveTextContent('Not working');
    expect(screen.getByTestId('system-state-models')).toHaveTextContent('Setup needed');
  });

  it('shows the recovery link for a failed component', async () => {
    respond(ready);
    renderWidget();

    await waitFor(() => expect(screen.getByTestId('system-action-worker')).toBeInTheDocument());
    expect(screen.getByTestId('system-action-worker')).toHaveAttribute('href', '/setup');
  });

  it('states the reason in plain language', async () => {
    respond(ready);
    renderWidget();

    await waitFor(() =>
      expect(screen.getByText(/No worker has published a heartbeat/)).toBeInTheDocument(),
    );
  });

  it('a FAILED request shows an error and never a stale green panel', async () => {
    // The lie this widget exists to prevent: a poll that stops arriving while
    // the last good render stays on screen saying Ready.
    respond({ title: 'Service Unavailable', status: 503 }, false, 503);
    renderWidget();

    await waitFor(() => expect(screen.queryByTestId('system-status-list')).not.toBeInTheDocument());
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('a poll that STARTS failing replaces the panel, it does not go stale', async () => {
    // The real staleness scenario, which a fail-on-first-load test cannot show:
    // React Query keeps `data` after a refetch fails, so a widget that rendered
    // children whenever data existed would keep showing "Ready" from a response
    // that stopped arriving. frameState puts the frame in `error`, and
    // WidgetFrame renders children ONLY in `ready` — this asserts that pairing.
    respond(ready);
    renderWidget();
    await waitFor(() => expect(screen.getByTestId('system-status-list')).toBeInTheDocument());
    expect(screen.getByTestId('system-state-database')).toHaveTextContent('Ready');

    respond({ title: 'Service Unavailable', status: 503 }, false, 503);
    await userEvent.click(screen.getByTestId('system-status-refresh'));

    await waitFor(() => expect(screen.queryByTestId('system-status-list')).not.toBeInTheDocument());
    // And nothing green is left behind.
    expect(screen.queryByTestId('system-state-database')).not.toBeInTheDocument();
  });

  it('keeps technical detail behind an expandable control', async () => {
    respond(ready);
    renderWidget();
    await waitFor(() => expect(screen.getByTestId('system-status-list')).toBeInTheDocument());

    const toggle = screen.getByTestId('system-status-diagnostics-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('system-status-diagnostics')).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('system-status-diagnostics')).toBeInTheDocument();
  });

  it('offers a manual refresh', async () => {
    respond(ready);
    renderWidget();
    await waitFor(() => expect(screen.getByTestId('system-status-list')).toBeInTheDocument());

    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByTestId('system-status-refresh'));

    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('every recovery link is reachable by keyboard', async () => {
    respond(ready);
    renderWidget();
    await waitFor(() => expect(screen.getByTestId('system-status-list')).toBeInTheDocument());

    // Anchors and buttons are focusable by default; this fails if a link is
    // ever swapped for a click handler on a div.
    for (const id of ['system-action-worker', 'system-action-models']) {
      const el = screen.getByTestId(id);
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });
});
