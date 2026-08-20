import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HotspotLeaderboard } from './HotspotLeaderboard.js';
import type { HotspotItems } from './contracts.js';

// The cross-repo leaderboard listed src/mod2.ts three times, identically: three
// real files in three repositories rendered as one row repeated. A ranked list
// whose rows cannot be told apart is a list nobody can act on.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));

// <Link> needs a router; the identity of the row is what is under test, not the
// navigation, so it renders as a plain anchor here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#test">{children}</a>,
}));

type Item = HotspotItems['items'][number];

const hotspot = (repoId: number, name: string, path: string, score: number): Item => ({
  repoId,
  repo: { id: repoId, org: 'acme', name },
  path,
  score,
});

function renderWith(items: Item[]) {
  useApiQuery.mockReturnValue({
    data: { items },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return render(<HotspotLeaderboard window="30d" search={{}} />);
}

describe('hotspot leaderboard row identity', () => {
  it('tells apart two rows for the same path in different repositories', () => {
    renderWith([
      hotspot(1, 'web', 'src/mod2.ts', 0.78),
      hotspot(2, 'api', 'src/mod2.ts', 0.44),
      hotspot(3, 'worker', 'src/mod2.ts', 0.1),
    ]);

    const rows = screen.getAllByTestId(/^row-/);
    expect(rows).toHaveLength(3);
    // Visible text, not test ids: the reader has only what is on screen.
    const text = rows.map((r) => r.textContent ?? '');
    expect(text[0]).toContain('acme/web');
    expect(text[1]).toContain('acme/api');
    expect(text[2]).toContain('acme/worker');
    expect(new Set(text).size).toBe(3);
  });

  it('names the column Repository, matching the Findings explorer', () => {
    renderWith([hotspot(1, 'web', 'src/a.ts', 0.5), hotspot(2, 'api', 'src/b.ts', 0.4)]);
    expect(screen.getByRole('columnheader', { name: 'Repository' })).toBeTruthy();
  });

  it('keeps the score on the row beside its repository', () => {
    renderWith([hotspot(1, 'web', 'src/mod2.ts', 0.78), hotspot(2, 'api', 'src/mod2.ts', 0.44)]);
    const first = screen.getAllByTestId(/^row-/)[0]!;
    expect(within(first).getByText('0.78')).toBeTruthy();
    expect(first.textContent).toContain('acme/web');
  });

  it('does NOT add the column when every row is in one repository', () => {
    // A single-repo workspace would otherwise read the same value down a whole
    // column, spending width on a fact the rows already share.
    renderWith([hotspot(1, 'web', 'src/a.ts', 0.5), hotspot(1, 'web', 'src/b.ts', 0.4)]);
    expect(screen.queryByRole('columnheader', { name: 'Repository' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'File' })).toBeTruthy();
  });
});
