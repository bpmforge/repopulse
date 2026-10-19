import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSchedulePanel } from './AiSchedulePanel.js';
import type { AiPassSchedule } from '../findings/aiContracts.js';

// W19-12. A schedule is off until an admin turns it on, and turning it on (or
// letting it reach hosted models) shows the server's acknowledgement and will
// not save until it is ticked.

const ACK = {
  version: 'w19-12/1',
  text: 'I understand that RepoPulse will send this repository’s code without anyone pressing start.',
};

const off: AiPassSchedule = {
  saved: false,
  enabled: false,
  scope: 'new_commits',
  paths: [],
  cadence: 'weekly',
  monthly_cap: 4,
  require_local: true,
  acknowledged_by: null,
  acknowledged_at: null,
  ack_version: null,
  last_scheduled_at: null,
  last_head_sha: null,
  next_due_at: null,
  started_this_month: 0,
  updated_at: null,
};

const state = vi.hoisted(() => ({
  schedule: null as unknown,
  role: 'admin' as string | undefined,
  mutate: vi.fn(),
  isError: false,
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: (d: { endpoint: string }) =>
    d.endpoint === '/me/context'
      ? { data: { role: state.role } }
      : {
          data: state.isError ? undefined : { schedule: state.schedule, acknowledgement: ACK },
          isLoading: false,
          isError: state.isError,
        },
  useApiMutation: () => ({ mutate: state.mutate, isPending: false, error: null }),
  queryKeyFor: () => [],
}));

beforeEach(() => {
  state.schedule = off;
  state.role = 'admin';
  state.mutate.mockReset();
  state.isError = false;
});

describe('AiSchedulePanel', () => {
  it('says it is off, and that nothing starts unless someone presses start', () => {
    render(<AiSchedulePanel repoId="3" />);
    expect(screen.getByTestId('ai-schedule-state').textContent).toMatch(/Off\./);
    expect(screen.getByTestId('ai-schedule-state').textContent).toMatch(/presses start/);
    expect(screen.queryByTestId('ai-schedule-ack-box')).toBeNull();
  });

  it('turning it on shows the acknowledgement and will not save until it is ticked', () => {
    render(<AiSchedulePanel repoId="3" />);
    fireEvent.click(screen.getByTestId('ai-schedule-enabled'));
    expect(screen.getByTestId('ai-schedule-ack-box').textContent).toContain(ACK.text);
    const save = screen.getByTestId('ai-schedule-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ai-schedule-ack-check'));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(state.mutate).toHaveBeenCalledWith({
      enabled: true,
      scope: 'new_commits',
      paths: [],
      cadence: 'weekly',
      monthly_cap: 4,
      require_local: true,
      acknowledge: 'w19-12/1',
    });
  });

  it('a paths schedule needs paths; the cap must be 1 to 31', () => {
    state.schedule = { ...off, enabled: true, acknowledged_at: '2026-10-19T10:00:00Z' };
    render(<AiSchedulePanel repoId="3" />);
    const save = screen.getByTestId('ai-schedule-save') as HTMLButtonElement;
    fireEvent.click(screen.getByTestId('ai-schedule-scope-paths'));
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ai-schedule-paths'), { target: { value: 'src/a\nlib' } });
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('ai-schedule-cap'), { target: { value: '40' } });
    expect(save.disabled).toBe(true);
  });

  it('an enabled schedule says who turned it on, when it is next due and the month against the cap', () => {
    state.schedule = {
      ...off,
      saved: true,
      enabled: true,
      acknowledged_by: 'ada',
      acknowledged_at: '2026-10-12T09:30:00Z',
      ack_version: 'w19-12/1',
      last_scheduled_at: '2026-10-12T10:19:00Z',
      next_due_at: '2026-10-19T09:19:00Z',
      started_this_month: 2,
    };
    render(<AiSchedulePanel repoId="3" />);
    expect(screen.getByTestId('ai-schedule-state').textContent).toMatch(
      /On\..*weekly.*commits ingested since the last scheduled pass.*network only/,
    );
    expect(screen.getByTestId('ai-schedule-ack').textContent).toMatch(/ada on 2026-10-12 09:30/);
    expect(screen.getByTestId('ai-schedule-next').textContent).toMatch(/2026-10-19 09:19/);
    expect(screen.getByTestId('ai-schedule-month').textContent).toMatch(/2 of 4/);
    // Editing the cap of an enabled schedule needs no second acknowledgement...
    expect(screen.queryByTestId('ai-schedule-ack-box')).toBeNull();
    // ...letting it reach hosted models does.
    fireEvent.click(screen.getByTestId('ai-schedule-local'));
    expect(screen.getByTestId('ai-schedule-ack-box')).toBeTruthy();
  });

  it('a member sees the state but no form', () => {
    state.role = 'member';
    render(<AiSchedulePanel repoId="3" />);
    expect(screen.getByTestId('ai-schedule-admin-only')).toBeTruthy();
    expect(screen.queryByTestId('ai-schedule-save')).toBeNull();
  });

  it('a failed load says nothing about whether a schedule is on', () => {
    state.isError = true;
    render(<AiSchedulePanel repoId="3" />);
    expect(screen.getByTestId('ai-schedule-unavailable').textContent).toMatch(/says nothing/);
  });
});
