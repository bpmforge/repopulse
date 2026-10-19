import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifiedFix, type PatchResponse } from './VerifiedFix.js';

// "Verified fix" in the finding drawer (W18-19). The API decides what each
// caller may see; what is pinned here is that the panel shows a verified patch
// with copy and download and the re-scan note, never shows a rejected diff (an
// admin also gets the reason), and offers a draft only when the finding is
// eligible. W20-06: a rejection keeps the section with Try again (AI-13), and
// the drafting connection is named before the button (AI-12).

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

  it('W20-06 (UX_TODO AI-13): a rejected attempt says it did not pass, with Try again, and no diff or reason for a developer', () => {
    respond({ eligible: true, patch: { ...base, status: 'rejected' } });
    render(<VerifiedFix findingId={5} />);
    expect(screen.getByTestId('verified-fix-rejected')).toHaveTextContent(
      /A drafted fix did not pass the re-scan/,
    );
    expect(screen.queryByTestId('verified-fix-admin-reason')).toBeNull();
    expect(screen.queryByTestId('verified-fix-diff')).toBeNull();
    fireEvent.click(screen.getByTestId('verified-fix-retry'));
    // An explicit retry: the API returns a decided answer otherwise.
    expect(state.mutate).toHaveBeenCalledWith({ tier: 't2', retry: true });
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

  it('W20-06 (UX_TODO AI-12): names the drafting connection and whether the file leaves, before the button', () => {
    respond({
      eligible: true,
      patch: null,
      drafter: {
        local_only: false,
        leaves_network: true,
        destinations: [
          {
            provider_name: 'Gemini',
            host: 'generativelanguage.googleapis.com',
            leaves_network: true,
            models: ['gemini-2.5-flash'],
          },
          {
            provider_name: 'LM Studio',
            host: '10.0.0.5:1234',
            leaves_network: false,
            models: ['m'],
          },
        ],
      },
    });
    render(<VerifiedFix findingId={5} />);
    const note = screen.getByTestId('verified-fix-drafter');
    expect(note).toHaveTextContent(
      /Drafted by Gemini \(gemini-2\.5-flash\) · leaves your network: the file is sent to generativelanguage\.googleapis\.com, or if it is down, LM Studio \(m\) · stays on your network/,
    );
    expect(
      note.compareDocumentPosition(screen.getByTestId('verified-fix-draft')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says when no model is set up to draft fixes', () => {
    respond({
      eligible: true,
      patch: null,
      drafter: { local_only: false, leaves_network: false, destinations: [] },
    });
    render(<VerifiedFix findingId={5} />);
    expect(screen.getByTestId('verified-fix-drafter')).toHaveTextContent(/No model is set up/);
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
