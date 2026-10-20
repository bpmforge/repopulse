import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiControls } from './AiControls.js';

// W20-18 (UX_TODO AI-77; decision 2026-10-20: off means off). One switch for the
// whole workspace, asked before it is thrown, and every schedule in one list with
// Turn off and Turn off every schedule.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  calls: [] as { endpoint: string; body: unknown }[],
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: state.data, isLoading: false, isError: false }),
  useApiMutation: (d: { endpoint: string; path?: Record<string, unknown> }) => ({
    mutate: (body: unknown) =>
      state.calls.push({
        endpoint: d.endpoint.replace('{id}', String(d.path?.id ?? '')),
        body,
      }),
    isPending: false,
    error: null,
  }),
  queryKeyFor: () => [],
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { to: string; children: ReactNode }) => <a {...rest}>{children}</a>,
}));

const schedule = (repoId: number, over = {}) => ({
  repo: { id: repoId, org: 'acme', name: `repo${repoId}` },
  enabled: true,
  frequency: 'daily',
  scope: { kind: 'paths', paths: ['src'] },
  enabled_by: 'ada',
  next_run_at: '2026-10-21T02:00:00Z',
  last_run_at: null,
  window: { start_hour: 1, end_hour: 6 },
  acknowledgement_stale: false,
  ...over,
});

beforeEach(() => {
  state.calls = [];
  state.data = {
    server_time_zone: 'Europe/London',
    ai_paused: { paused: false, paused_by: null, paused_at: null },
    schedules: [schedule(1), schedule(2, { enabled: false, window: null })],
  };
});

describe('AiControls', () => {
  it('asks before switching AI off, saying what stops, then sends paused', () => {
    render(<AiControls />);
    expect(screen.getByTestId('ai-switch-on')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-switch-pause'));
    expect(state.calls).toHaveLength(0);
    expect(screen.getByTestId('ai-switch-confirm')).toHaveTextContent(
      /verified-fix draft stops, including ones a person asks for/,
    );
    fireEvent.click(screen.getByTestId('ai-switch-confirm-do'));
    expect(state.calls).toEqual([{ endpoint: '/ai-pass/pause', body: { paused: true } }]);
  });

  it('when off, says so and switches back on without asking', () => {
    state.data = {
      ...(state.data as object),
      ai_paused: { paused: true, paused_by: 'ada', paused_at: null },
    };
    render(<AiControls />);
    expect(screen.getByTestId('ai-switch-off')).toHaveTextContent(
      'AI is off for this workspace (switched off by ada)',
    );
    expect(screen.getByTestId('ai-schedule-1')).toHaveTextContent('paused (AI is off)');
    fireEvent.click(screen.getByTestId('ai-switch-resume'));
    expect(state.calls).toEqual([{ endpoint: '/ai-pass/pause', body: { paused: false } }]);
  });

  it('lists every schedule with its window in the server zone, and turns one or all off', () => {
    render(<AiControls />);
    expect(
      screen.getByRole('columnheader', { name: /Run window \(Europe\/London\)/ }),
    ).toBeTruthy();
    expect(screen.getByTestId('ai-schedule-1')).toHaveTextContent('01:00–06:00');
    expect(screen.getByTestId('ai-schedule-2')).toHaveTextContent('Off');
    expect(screen.queryByTestId('ai-schedule-disable-2')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-schedule-disable-1'));
    expect(state.calls[0]).toEqual({
      endpoint: '/repos/1/ai-pass/schedule',
      body: { enabled: false },
    });
    fireEvent.click(screen.getByTestId('ai-schedules-disable-all'));
    expect(screen.getByTestId('ai-schedules-confirm')).toHaveTextContent(
      'Turn off all 1 schedule?',
    );
    fireEvent.click(screen.getByTestId('ai-schedules-disable-all-do'));
    expect(state.calls[1]).toEqual({ endpoint: '/ai-pass/schedules/disable-all', body: {} });
  });
});
