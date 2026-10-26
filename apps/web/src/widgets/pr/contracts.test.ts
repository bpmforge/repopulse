import { describe, expect, it } from 'vitest';
import { checkDetail, type PrCheck } from './contracts.js';

// W21-01: a PR's checks listed "ci" twice — a workflow run and its check run,
// or a re-run — with nothing to tell the rows apart.
describe('checkDetail', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const base: PrCheck = { name: 'ci', conclusion: 'success', status: 'completed' };

  it('names the kind, so a workflow run and its check run differ', () => {
    const run = checkDetail({ ...base, kind: 'workflow_run', completed_at: null }, now);
    const check = checkDetail({ ...base, kind: 'check_run', completed_at: null }, now);
    expect(run).toBe('workflow run');
    expect(check).toBe('check');
  });

  it('says which attempt a re-run is, and when it finished', () => {
    const text = checkDetail(
      { ...base, kind: 'check_run', run_attempt: 2, completed_at: '2026-10-25T09:30:00Z' },
      now,
    );
    expect(text).toMatch(/^check · attempt 2 · finished /);
    // The first attempt is not called "attempt 1".
    expect(checkDetail({ ...base, kind: 'check_run', run_attempt: 1 }, now)).toBe('check');
  });

  it('says a check that has not finished is running, or when it started', () => {
    expect(checkDetail({ ...base, status: 'in_progress', conclusion: null }, now)).toBe(
      'in progress',
    );
    expect(
      checkDetail(
        { ...base, status: 'in_progress', conclusion: null, started_at: '2026-10-26T11:00:00Z' },
        now,
      ),
    ).toMatch(/^started /);
  });
});
