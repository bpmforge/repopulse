import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CiTrends } from './CiTrends.js';

// W20-20 (UX_TODO DSH-29): a flaky workflow row opens its runs on the forge,
// and a row with no known forge link stays plain text rather than a dead link.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));

const ci = {
  window: '30d',
  computed_at: '2026-10-01T00:00:00.000Z',
  pass_rate: 0.9,
  pr_pass_rate: 0.8,
  default_branch_runs: 20,
  pr_runs: 40,
  duration: { medianMs: 60_000, p90Ms: 120_000 },
  flakiest: [
    {
      workflow: 'build',
      flakiness: 0.25,
      rerun_groups: 4,
      flipped_groups: 1,
      runs_url: 'https://github.com/acme/api/actions?query=workflow%3A%22build%22',
    },
    { workflow: 'lint', flakiness: null, rerun_groups: 0, flipped_groups: 0, runs_url: null },
  ],
  flakiness_workflows: 2,
  components_available: true,
};

describe('CI flakiest workflows (DSH-29)', () => {
  it('links a row to its runs and leaves an unlinked one as text', () => {
    useApiQuery.mockImplementation(({ endpoint }: { endpoint: string }) => ({
      data: endpoint === '/repos/{id}/ci' ? ci : { points: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }));
    render(<CiTrends repoId="7" window="30d" />);
    const link = screen.getByTestId('ci-flaky-runs-build');
    expect(link).toHaveAttribute('href', ci.flakiest[0]!.runs_url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByTestId('ci-flaky-runs-lint')).toBeNull();
    expect(screen.getByText('lint')).toBeInTheDocument();
  });
});
