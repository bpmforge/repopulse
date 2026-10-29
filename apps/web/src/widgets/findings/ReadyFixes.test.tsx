import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadyFixes, type ReadyFix } from './ReadyFixes.js';

// "Fixes ready to apply" (W22-09): the verified fixes the API lists, riskiest
// first, each opening its finding (where the diff is copied or downloaded).
// Nothing is shown while there is none, and the copy never offers a PR.

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: null as unknown,
  descriptors: [] as unknown[],
}));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiQuery: (d: unknown) => {
    state.descriptors.push(d);
    return { data: state.data, error: state.error };
  },
}));

const fix = (over: Partial<ReadyFix> = {}): ReadyFix => ({
  patch_id: 1,
  finding_id: 11,
  title: 'eval of input',
  file: 'src/run.js',
  line_start: 2,
  severity: 4,
  dimension: 'sast',
  effective_risk: 90,
  verify_status: 'confirmed',
  repo: { id: 3, name: 'api' },
  commit_sha: 'abcdef1234567',
  model_id: 'm1',
  drafted_by: 'auto',
  finished_at: '2026-10-29T00:00:00Z',
  ...over,
});

beforeEach(() => {
  state.data = undefined;
  state.error = null;
  state.descriptors = [];
});

describe('ReadyFixes', () => {
  it('renders nothing while there is no ready fix', () => {
    state.data = { items: [] };
    const { container } = render(<ReadyFixes onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each verified fix and opens its finding', () => {
    state.data = {
      items: [
        fix(),
        fix({ patch_id: 2, finding_id: 12, title: 'n+1', file: 'src/db.js', drafted_by: 'person' }),
      ],
    };
    const onOpen = vi.fn();
    render(<ReadyFixes onOpen={onOpen} />);
    expect(screen.getByText('Fixes ready to apply (2)')).toBeInTheDocument();
    expect(screen.getByText('src/run.js:2')).toBeInTheDocument();
    expect(screen.getByTestId('ready-fix-auto-11')).toHaveTextContent('drafted after the scan');
    expect(screen.queryByTestId('ready-fix-auto-12')).toBeNull();
    fireEvent.click(screen.getByTestId('ready-fix-12'));
    expect(onOpen).toHaveBeenCalledWith(12);
    // Read-only towards the repository (D9a): no pull-request action.
    expect(screen.queryByText(/pull request/i)).toBeNull();
    expect(screen.getByTestId('ready-fixes')).toHaveTextContent('does not change your repository');
  });

  it('passes the topbar repository filter through', () => {
    state.data = { items: [] };
    render(<ReadyFixes repos="3,4" onOpen={() => {}} />);
    expect(state.descriptors[0]).toEqual({ endpoint: '/patches/ready', query: { repo_id: '3,4' } });
  });

  it('says so when the list could not be loaded', () => {
    state.error = new Error('boom');
    render(<ReadyFixes onOpen={() => {}} />);
    expect(screen.getByTestId('ready-fixes-error')).toBeInTheDocument();
  });
});
