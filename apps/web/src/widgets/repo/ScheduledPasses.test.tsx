import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledPasses } from './ScheduledPasses.js';
import type { ScheduleResponse } from '../findings/aiContracts.js';

// W19-12. Off by default and said so; enabling shows where source would be sent
// (the server's own statement) and needs it ticked; a stale acknowledgement is
// loud; every skipped run shows its reason.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
  put: vi.fn(),
  cap: vi.fn(),
  putError: null as unknown,
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: state.data, isLoading: false, isError: state.isError }),
  useApiMutation: (d: { endpoint: string }) =>
    d.endpoint === '/ai-pass/settings'
      ? { mutate: state.cap, isPending: false, error: null }
      : { mutate: state.put, isPending: false, error: state.putError },
  queryKeyFor: () => [],
}));

const local = {
  provider_id: 1,
  provider_name: 'LM Studio',
  host: '10.0.0.5:1234',
  leaves_network: false,
  roles: ['security', 'triage'],
};
const hosted = {
  provider_id: 2,
  provider_name: 'Hosted',
  host: 'api.example.com',
  leaves_network: true,
  roles: ['code_health'],
};

const resp = (over: Partial<ScheduleResponse> = {}): ScheduleResponse => ({
  schedule: null,
  egress: {
    local_only: false,
    destinations: [local],
    leaves_network: false,
    digest: 'digest-1',
    sentence: 'Stays on your network. Source is sent only to LM Studio (10.0.0.5:1234).',
    sends: 'the contents of the files in scope, or the diff of a pull request, with their paths',
  },
  acknowledgement_stale: false,
  monthly: { cap: 300, used: 40, remaining: 260 },
  limits: { passes_per_day: 10, tick_minutes: 15 },
  runs: [],
  ...over,
});
const on = (over = {}) => ({
  enabled: true,
  frequency: 'weekly' as const,
  scope: { kind: 'paths' as const, paths: ['src/payments'] },
  enabled_by: 'ada',
  enabled_at: '2026-10-11T09:00:00Z',
  last_run_at: '2026-10-18T09:00:00Z',
  next_run_at: '2026-10-25T09:00:00Z',
  ...over,
});

beforeEach(() => {
  state.data = resp();
  state.isError = false;
  state.put.mockReset();
  state.cap.mockReset();
  state.putError = null;
});

describe('ScheduledPasses', () => {
  it('says it is OFF by default and that nothing is sent unless someone starts a pass', () => {
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-off').textContent).toMatch(/Off/);
    expect(screen.getByTestId('schedule-off').textContent).toMatch(
      /Nothing is sent to a model unless someone starts a pass/,
    );
    expect(screen.queryByTestId('schedule-form')).toBeNull();
    expect(screen.getByTestId('schedule-runs-empty').textContent).toMatch(
      /Nothing has run on a schedule/,
    );
  });

  it('only an admin can set one up', () => {
    render(<ScheduledPasses repoId="3" isAdmin={false} />);
    expect(screen.queryByTestId('schedule-edit')).toBeNull();
    expect(screen.queryByTestId('schedule-cap-input')).toBeNull();
    expect(document.body.textContent).toMatch(/An admin sets up and changes schedules/);
  });

  it('enabling shows where source goes and needs the acknowledgement ticked, then sends the digest', () => {
    render(<ScheduledPasses repoId="3" isAdmin />);
    fireEvent.click(screen.getByTestId('schedule-edit'));
    expect(screen.getByTestId('schedule-egress-sentence').textContent).toMatch(
      /^Stays on your network/,
    );
    expect(screen.getByTestId('schedule-dest-1').textContent).toMatch(
      /10\.0\.0\.5:1234 — on your network/,
    );
    const enable = screen.getByTestId('schedule-enable');
    fireEvent.change(screen.getByTestId('schedule-paths'), {
      target: { value: 'src/payments\nlib' },
    });
    expect(enable).toHaveProperty('disabled', true); // not acknowledged
    fireEvent.click(screen.getByTestId('schedule-ack'));
    expect(enable).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByTestId('schedule-frequency-daily'));
    fireEvent.click(enable);
    expect(state.put.mock.calls[0]![0]).toEqual({
      enabled: true,
      frequency: 'daily',
      scope: { kind: 'paths', paths: ['src/payments', 'lib'] },
      acknowledged_egress: 'digest-1',
    });
  });

  it('a hosted destination is shown as LEAVING the network, in words, not only colour', () => {
    state.data = resp({
      egress: {
        ...resp().egress,
        destinations: [local, hosted],
        leaves_network: true,
        sentence: 'Leaves your network: Hosted (api.example.com) would receive the contents.',
      },
    });
    render(<ScheduledPasses repoId="3" isAdmin />);
    fireEvent.click(screen.getByTestId('schedule-edit'));
    expect(screen.getByTestId('schedule-egress').getAttribute('data-leaves')).toBe('true');
    expect(screen.getByTestId('schedule-egress-sentence').textContent).toMatch(
      /^Leaves your network/,
    );
    expect(screen.getByTestId('schedule-dest-2').textContent).toMatch(/off your network/);
  });

  it('cannot be enabled with no model: the acknowledgement is unavailable and the reason is shown', () => {
    state.data = resp({
      egress: {
        ...resp().egress,
        destinations: [],
        sentence:
          'No model connection is configured for these roles, so a scheduled pass could not run.',
      },
    });
    render(<ScheduledPasses repoId="3" isAdmin />);
    fireEvent.click(screen.getByTestId('schedule-edit'));
    expect(screen.getByTestId('schedule-ack')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('schedule-enable')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('schedule-egress-sentence').textContent).toMatch(
      /No model connection/,
    );
  });

  it('the new-pull-requests scope needs no paths and says how it picks', () => {
    render(<ScheduledPasses repoId="3" isAdmin />);
    fireEvent.click(screen.getByTestId('schedule-edit'));
    fireEvent.click(screen.getByTestId('schedule-scope-prs'));
    fireEvent.click(screen.getByTestId('schedule-ack'));
    expect(document.body.textContent).toMatch(/reviewed again only when its head changes/);
    fireEvent.click(screen.getByTestId('schedule-enable'));
    expect(state.put.mock.calls[0]![0]).toMatchObject({ scope: { kind: 'new_pull_requests' } });
  });

  it('an enabled schedule shows its times and who enabled it, and can be turned off', () => {
    state.data = resp({ schedule: on() });
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-on').textContent).toMatch(
      /Weekly, reviewing src\/payments/,
    );
    expect(screen.getByTestId('schedule-times').textContent).toMatch(
      /Next run Oct 25, 2026, 09:00/,
    );
    expect(screen.getByTestId('schedule-times').textContent).toMatch(/enabled by ada/);
    fireEvent.click(screen.getByTestId('schedule-off-button'));
    expect(state.put).toHaveBeenCalledWith({ enabled: false });
  });

  it('a stale acknowledgement is loud: not running, and why, with the way back', () => {
    state.data = resp({ schedule: on(), acknowledgement_stale: true });
    render(<ScheduledPasses repoId="3" isAdmin />);
    const stale = screen.getByTestId('schedule-stale');
    expect(stale.getAttribute('role')).toBe('alert');
    expect(stale.textContent).toMatch(/not running/);
    expect(screen.getByTestId('schedule-edit').textContent).toBe('Review and re-acknowledge');
  });

  it('states the monthly cap and what it does, and an admin can change it', () => {
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-cap').textContent).toMatch(
      /40 of 300 model calls used this month \(260 left\)/,
    );
    expect(screen.getByTestId('schedule-cap').textContent).toMatch(/never blocked by it/);
    const save = screen.getByTestId('schedule-cap-save');
    // Pre-filled with the current cap, and saving an unchanged value is not offered.
    expect((screen.getByTestId('schedule-cap-input') as HTMLInputElement).value).toBe('300');
    expect(save).toHaveProperty('disabled', true);
    for (const bad of ['abc', '-1', '1.5', '1000000']) {
      fireEvent.change(screen.getByTestId('schedule-cap-input'), { target: { value: bad } });
      expect(save, bad).toHaveProperty('disabled', true);
    }
    fireEvent.change(screen.getByTestId('schedule-cap-input'), { target: { value: '120' } });
    fireEvent.click(save);
    expect(state.cap).toHaveBeenCalledWith({ monthly_call_cap: 120 }, expect.anything());
  });

  it('lists the last scheduled runs, including the skipped ones with their reason', () => {
    state.data = resp({
      schedule: on(),
      runs: [
        {
          id: 9,
          status: 'skipped',
          mode: 'paths',
          pr_number: null,
          paths: ['src'],
          reason_code: 'cap_reached',
          reason: 'This workspace’s monthly cap of 300 model calls is used up.',
          calls: 0,
          created_at: '2026-10-18T09:00:00Z',
          finished_at: '2026-10-18T09:00:00Z',
        },
        {
          id: 8,
          status: 'succeeded',
          mode: 'paths',
          pr_number: null,
          paths: ['src'],
          reason_code: null,
          reason: null,
          calls: 12,
          created_at: '2026-10-11T09:00:00Z',
          finished_at: '2026-10-11T09:20:00Z',
        },
      ],
    });
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-run-9').textContent).toMatch(/skipped/);
    expect(screen.getByTestId('schedule-run-9').textContent).toMatch(/monthly cap of 300/);
    expect(screen.getByTestId('schedule-run-8').textContent).toMatch(/finished.*12 calls/);
  });

  it('says a load failure is not news about whether a schedule is on', () => {
    state.isError = true;
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-unavailable').textContent).toMatch(
      /says nothing about whether one is on/,
    );
  });

  it('shows the server’s refusal when enabling fails', () => {
    state.putError = Object.assign(new Error('Acknowledge where source is sent'), {
      status: 409,
      detail: 'The destinations changed since you were shown them.',
    });
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-error').textContent).toMatch(
      /Acknowledge|destinations changed/,
    );
  });
  // W20-11 (UX_TODO AI-37): a greyed-out Enable says what is missing.
  it('says why Enable schedule is greyed out', () => {
    render(<ScheduledPasses repoId="3" isAdmin />);
    fireEvent.click(screen.getByTestId('schedule-edit'));
    expect(screen.getByTestId('schedule-enable').getAttribute('aria-describedby')).toBe(
      'schedule-enable-hint',
    );
    expect(screen.getByTestId('schedule-enable-hint')).toHaveTextContent(
      'To enable: enter at least one path; tick the box above',
    );
    fireEvent.change(screen.getByTestId('schedule-paths'), { target: { value: 'src' } });
    fireEvent.click(screen.getByTestId('schedule-ack'));
    expect(screen.queryByTestId('schedule-enable-hint')).toBeNull();
  });

  // W20-11 (UX_TODO AI-36): the cap is workspace-wide, and saving says so.
  it('labels the cap as workspace-wide and confirms a save', () => {
    state.cap.mockImplementation((_b: unknown, o?: { onSuccess?: () => void }) => o?.onSuccess?.());
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(document.body.textContent).toMatch(
      /Workspace monthly cap \(model calls, all repositories\)/,
    );
    fireEvent.change(screen.getByTestId('schedule-cap-input'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('schedule-cap-save'));
    expect(screen.getByTestId('schedule-cap-saved')).toHaveTextContent('Saved.');
  });

  // W20-11 (UX_TODO AI-62): a failed pull-request review is retried, and says so.
  it('says a failed pull-request review will be tried again', () => {
    state.data = resp({
      schedule: on({ scope: { kind: 'new_pull_requests' as const } }),
      runs: [
        {
          id: 4,
          status: 'failed',
          mode: 'pull_request',
          pr_number: 12,
          paths: [],
          reason_code: 'error',
          reason: 'The model was not reachable.',
          calls: 0,
          created_at: '2026-10-18T09:00:00Z',
          finished_at: '2026-10-18T09:00:00Z',
        },
      ],
    });
    render(<ScheduledPasses repoId="3" isAdmin />);
    expect(screen.getByTestId('schedule-run-retry')).toHaveTextContent(
      'PR #12: review failed. A later scheduled run tries it again, up to 3 times',
    );
  });
});
