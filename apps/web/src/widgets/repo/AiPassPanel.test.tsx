import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiPassPanel } from './AiPassPanel.js';
import type { AiPassRun } from '../findings/aiContracts.js';

// W19-10. A repository nobody has run a pass on says "not yet run"; the caps are
// on the screen; a refusal shows the server's reason; only an admin can start.

const state = vi.hoisted(() => ({
  runs: [] as unknown[],
  role: 'admin' as string | undefined,
  mutate: vi.fn(),
  isPending: false,
  error: null as unknown,
  isError: false,
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: (d: { endpoint: string }) =>
    d.endpoint === '/me/context'
      ? { data: { role: state.role } }
      : { data: { runs: state.runs }, isLoading: false, isError: state.isError },
  useApiMutation: () => ({
    mutate: state.mutate,
    isPending: state.isPending,
    error: state.error,
  }),
  queryKeyFor: () => [],
}));

const run = (over: Partial<AiPassRun> = {}): AiPassRun => ({
  id: 1,
  status: 'succeeded',
  paths: ['src/payments'],
  commit_sha: 'abc1234',
  reason_code: null,
  reason: null,
  plan: null,
  specialists: {
    usage: { security: { calls: 1, findings: 1 }, performance: { calls: 1, findings: 0 } },
    droppedForBudget: ['test_coverage', 'ai_slop'],
  },
  triage_funnel: { candidates: 1, selected: 1, triaged: 1, accepted: 1, verdicts: { real: 1 } },
  triage_skipped: null,
  calls: 4,
  requested_by: 'ada',
  created_at: '2026-10-18T10:00:00Z',
  started_at: null,
  finished_at: null,
  ...over,
});

beforeEach(() => {
  state.runs = [];
  state.role = 'admin';
  state.mutate.mockReset();
  state.isPending = false;
  state.error = null;
  state.isError = false;
});

describe('AiPassPanel', () => {
  it('says "not yet run" when no pass was ever started - an absence of review, not a clean result', () => {
    render(<AiPassPanel repoId="3" />);
    expect(screen.getByTestId('ai-pass-not-run').textContent).toMatch(/Not yet run/);
    expect(screen.getByTestId('ai-pass-not-run').textContent).toMatch(/not a clean result/);
  });

  it('shows the caps up front', () => {
    render(<AiPassPanel repoId="3" />);
    const caps = screen.getByTestId('ai-pass-caps').textContent ?? '';
    expect(caps).toMatch(/40 files/);
    expect(caps).toMatch(/30 model calls/);
    expect(caps).toMatch(/10 passes a day/);
    expect(caps).toMatch(/never reads part of what you asked for/);
  });

  it('starts a pass with the named paths, trimmed, one per line', () => {
    render(<AiPassPanel repoId="3" />);
    const btn = screen.getByTestId('ai-pass-start');
    expect(btn).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('ai-pass-paths'), {
      target: { value: ' src/payments \n\nlib/a.ts,lib/b.ts' },
    });
    fireEvent.click(btn);
    expect(state.mutate).toHaveBeenCalledWith({
      paths: ['src/payments', 'lib/a.ts', 'lib/b.ts'],
    });
  });

  it("shows the server's reason when a start is refused", () => {
    state.error = Object.assign(new Error('Daily AI-pass limit reached'), {
      status: 429,
      detail: 'This workspace has started 10 passes in the last 24 hours (limit 10).',
    });
    render(<AiPassPanel repoId="3" />);
    expect(screen.getByTestId('ai-pass-error').textContent).toMatch(/limit/i);
  });

  it('only an admin gets the start form', () => {
    state.role = 'member';
    render(<AiPassPanel repoId="3" />);
    expect(screen.queryByTestId('ai-pass-start')).toBeNull();
    expect(screen.getByTestId('ai-pass-admin-only')).toBeTruthy();
  });

  it('reports what a finished pass raised, what it did not run, and the triage outcome', () => {
    state.runs = [run()];
    render(<AiPassPanel repoId="3" />);
    expect(screen.getByTestId('ai-pass-status').textContent).toBe('finished');
    expect(screen.getByTestId('ai-pass-raised').textContent).toMatch(/security 1/);
    expect(screen.getByTestId('ai-pass-raised').textContent).not.toMatch(/performance/);
    expect(screen.getByTestId('ai-pass-dropped').textContent).toMatch(/test coverage, ai slop/);
    expect(screen.getByTestId('ai-pass-dropped').textContent).toMatch(/says nothing about/);
    expect(screen.getByTestId('ai-pass-triage').textContent).toMatch(/1 finding reviewed/);
    expect(screen.getByTestId('ai-pass-triage').textContent).toMatch(/1 real/);
  });

  it('shows the reason for a failed pass and locks the button while one is running', () => {
    state.runs = [
      run({ id: 2, status: 'running', calls: null, specialists: null, triage_funnel: null }),
      run({
        id: 1,
        status: 'failed',
        reason: 'No model is configured. Add one in Admin → Models.',
        specialists: null,
        triage_funnel: null,
      }),
    ];
    render(<AiPassPanel repoId="3" />);
    fireEvent.change(screen.getByTestId('ai-pass-paths'), { target: { value: 'src' } });
    expect(screen.getByTestId('ai-pass-start')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('ai-pass-start').textContent).toBe('A pass is running');
    expect(screen.getByTestId('ai-pass-1').textContent).toMatch(/failed/);
    expect(screen.getByTestId('ai-pass-1').textContent).toMatch(/Add one in Admin → Models/);
  });

  it('starts a pass on a pull request by number, and only with a real number', () => {
    render(<AiPassPanel repoId="3" />);
    fireEvent.click(screen.getByTestId('ai-pass-mode-pull_request'));
    const btn = screen.getByTestId('ai-pass-start');
    expect(btn).toHaveProperty('disabled', true);
    for (const bad of ['', '0', 'abc', '1.5', '-3']) {
      fireEvent.change(screen.getByTestId('ai-pass-pr'), { target: { value: bad } });
      expect(btn, bad).toHaveProperty('disabled', true);
    }
    fireEvent.change(screen.getByTestId('ai-pass-pr'), { target: { value: ' 123 ' } });
    fireEvent.click(btn);
    expect(state.mutate).toHaveBeenCalledWith({ pull_request: 123 });
  });

  it('starts a pass on a commit range, says how a range is resolved, and needs two commit ids', () => {
    render(<AiPassPanel repoId="3" />);
    fireEvent.click(screen.getByTestId('ai-pass-mode-commit_range'));
    const btn = screen.getByTestId('ai-pass-start');
    fireEvent.change(screen.getByTestId('ai-pass-base'), { target: { value: 'a1b2c3d' } });
    expect(btn).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('ai-pass-head'), { target: { value: 'not a sha' } });
    expect(btn).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('ai-pass-head'), { target: { value: 'e4f5a6b' } });
    fireEvent.click(btn);
    expect(state.mutate).toHaveBeenCalledWith({ base: 'a1b2c3d', head: 'e4f5a6b' });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/no commit graph/);
    expect(text).toMatch(/a line number is as of the commit that changed it/);
  });

  it('names what each pass reviewed - paths, a pull request with its refs, or a range - and the files it could not read', () => {
    state.runs = [
      run({
        id: 3,
        mode: 'pull_request',
        pr_number: 12,
        paths: [],
        base_ref: 'main',
        head_ref: 'abcdef0123456789',
        specialists: { usage: {}, unreadable: ['assets/big.json'] },
      }),
      run({
        id: 2,
        mode: 'commit_range',
        paths: [],
        base_ref: 'aaaaaaa1234',
        head_ref: 'bbbbbbb5678',
      }),
      run({ id: 1, paths: ['src/payments'] }),
    ];
    render(<AiPassPanel repoId="3" />);
    expect(screen.getByTestId('ai-pass-3').textContent).toMatch(
      /the diff of pull request #12 \(base main, head abcdef01\)/,
    );
    expect(screen.getByTestId('ai-pass-3').textContent).toMatch(/assets\/big\.json/);
    expect(screen.getByTestId('ai-pass-2').textContent).toMatch(/the commits aaaaaaa1\.\.bbbbbbb5/);
    expect(screen.getByTestId('ai-pass-1').textContent).toMatch(/the files src\/payments/);
  });

  it('a refused scheduled pass is listed under Scheduled passes, not as a review; scheduled passes that ran stay, tagged', () => {
    state.runs = [
      run({
        id: 5,
        trigger: 'scheduled',
        status: 'skipped',
        reason: 'The monthly cap is used up.',
      }),
    ];
    render(<AiPassPanel repoId="3" />);
    // Only a refusal exists: no review was ever run, and the panel says so.
    expect(screen.queryByTestId('ai-pass-5')).toBeNull();
    expect(screen.getByTestId('ai-pass-not-run').textContent).toMatch(/Not yet run/);

    state.runs = [
      run({ id: 6, trigger: 'scheduled' }),
      run({
        id: 5,
        trigger: 'scheduled',
        status: 'skipped',
        reason: 'The monthly cap is used up.',
      }),
    ];
    render(<AiPassPanel repoId="3" />);
    expect(screen.getByTestId('ai-pass-6').textContent).toMatch(/scheduled/);
    expect(screen.queryByTestId('ai-pass-5')).toBeNull();
  });
});
