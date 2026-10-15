import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifiedFix, type PatchResponse } from './VerifiedFix.js';

// "Verified fix" in the finding drawer (W18-19). The API decides what each
// caller may see; what is pinned here is that the panel shows a verified patch
// with copy and download and the re-scan note, shows NOTHING for a rejected
// attempt unless the API handed it an admin's reason, and offers a draft only
// when the finding is eligible.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
  isPending: false,
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: state.data }),
  useApiMutation: () => ({ mutate: state.mutate, isPending: state.isPending, error: null }),
  queryKeyFor: () => [],
}));

const DIFF = [
  '--- a/src/run.js',
  '+++ b/src/run.js',
  '@@ -1,3 +1,3 @@',
  ' function run(cmd) {',
  '-  return eval(cmd);',
  '+  return JSON.parse(cmd);',
  ' }',
  '',
].join('\n');

function respond(r: PatchResponse) {
  state.data = r;
}

const base = {
  id: 9,
  commit_sha: 'abcdef1234567',
  tier: 2,
  created_at: '2026-10-15T00:00:00Z',
  finished_at: null,
};

beforeEach(() => {
  state.data = undefined;
  state.isPending = false;
  state.mutate.mockReset();
});

describe('VerifiedFix', () => {
  it('shows a verified patch, the re-scan note, and copy + download — and no PR action', async () => {
    respond({
      eligible: true,
      patch: {
        ...base,
        status: 'verified',
        diff: DIFF,
        filename: 'repopulse-finding-5-run.js.patch',
        model_id: 'qwen-local',
        verification: { rule_sets: ['semgrep_pack', 'anti_slop_fast_lane'], runs: 4 },
      },
    });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<VerifiedFix findingId={5} />);

    expect(screen.getByText('Verified fix')).toBeTruthy();
    const note = screen.getByTestId('verified-fix-note').textContent ?? '';
    expect(note).toContain('Re-scanned');
    expect(note).toContain('abcdef1');
    expect(note).toContain('security rules, code-health checks');
    expect(note).toContain('nothing has been written to your repository');
    expect(screen.getByTestId('verified-fix-diff').textContent).toContain(
      '+  return JSON.parse(cmd);',
    );

    fireEvent.click(screen.getByTestId('verified-fix-copy'));
    expect(writeText).toHaveBeenCalledWith(DIFF);
    expect(await screen.findByText('Copied')).toBeTruthy();

    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    fireEvent.click(screen.getByTestId('verified-fix-download'));
    expect(clicked).toEqual(['repopulse-finding-5-run.js.patch']);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    // D9a: the panel has no way to write to the forge.
    expect(screen.queryByText(/pull request|open a pr|commit this/i)).toBeNull();
  });

  it('shows NOTHING for a rejected attempt when no reason was sent (a developer)', () => {
    respond({ eligible: true, patch: { ...base, status: 'rejected' } });
    const { container } = render(<VerifiedFix findingId={5} />);
    expect(container.textContent).toBe('');
  });

  it('shows an admin the rejection reason, as diagnostics', () => {
    respond({
      eligible: true,
      patch: {
        ...base,
        status: 'rejected',
        reason: 'The patch introduces a new finding in the file: bpm-inner-html.',
      },
    });
    render(<VerifiedFix findingId={5} />);
    expect(screen.getByTestId('verified-fix-admin-reason').textContent).toContain('bpm-inner-html');
    expect(screen.queryByTestId('verified-fix-diff')).toBeNull();
  });

  it('offers a local draft for an eligible finding, and nothing for an ineligible one', () => {
    respond({ eligible: true, patch: null });
    const { unmount } = render(<VerifiedFix findingId={5} />);
    fireEvent.click(screen.getByTestId('verified-fix-draft'));
    expect(state.mutate).toHaveBeenCalledWith({ tier: 't2' });
    unmount();

    respond({ eligible: false, reason: 'model finding', patch: null });
    const { container } = render(<VerifiedFix findingId={5} />);
    expect(container.textContent).toBe('');
  });

  it('says it is working while a draft is pending, and offers a retry after a failure', () => {
    respond({ eligible: true, patch: { ...base, status: 'pending' } });
    const { unmount } = render(<VerifiedFix findingId={5} />);
    expect(screen.getByRole('status').textContent).toContain('re-scanning');
    unmount();

    respond({ eligible: true, patch: { ...base, status: 'failed' } });
    render(<VerifiedFix findingId={5} />);
    expect(screen.getByTestId('verified-fix-failed')).toBeTruthy();
    expect(screen.getByTestId('verified-fix-draft').textContent).toBe('Try again');
  });

  it('renders a hostile diff as text', () => {
    respond({
      eligible: true,
      patch: {
        ...base,
        status: 'verified',
        diff: '+<img src=x onerror="window.__pwned=1">\n',
        filename: 'x.patch',
      },
    });
    const { container } = render(<VerifiedFix findingId={5} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });
});
