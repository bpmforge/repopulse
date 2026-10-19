import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MyFocus } from './MyFocus.js';
import type { MyHotspot, MyPr, ReviewQueueItem } from './contracts.js';

// My Focus is cross-repo by construction, and PR numbers restart per repository:
// "#5 feature 5" listed twice was two different pull requests in two repos, and
// nothing on the row said which one to open.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#test">{children}</a>,
}));

const repo = (id: number, name: string) => ({ id, org: 'acme', name });

const pr = (id: number, name: string, number: number): MyPr => ({
  number,
  title: `feature ${number}`,
  repo_id: id,
  repo: repo(id, name),
  state: 'open',
  size_bucket: 'M',
  opened_at: '2026-08-18T00:00:00.000Z',
  merged_at: null,
  links: { self: '' },
});

const review = (id: number, name: string, number: number): ReviewQueueItem => ({
  number,
  title: `feature ${number}`,
  repo_id: id,
  repo: repo(id, name),
  author: 'dana',
  opened_at: '2026-08-18T00:00:00.000Z',
  links: { self: '' },
});

const owned = (id: number, name: string, path: string): MyHotspot => ({
  repo_id: id,
  repo: repo(id, name),
  path,
  my_lines: 120,
  links: { file: '' },
});

function renderWith(opts: { prs?: MyPr[]; queue?: ReviewQueueItem[]; hotspots?: MyHotspot[] }) {
  const byEndpoint: Record<string, unknown> = {
    // identity_id must be set or the widget short-circuits to the
    // identity-unlinked frame and renders no tables at all.
    '/me/context': { workspace: { id: 1, slug: 'a', name: 'A' }, role: 'member', identity_id: 7 },
    '/me/prs': { items: opts.prs ?? [] },
    '/me/review-queue': { items: opts.queue ?? [] },
    '/me/hotspots': { items: opts.hotspots ?? [] },
    '/me/stats': { merged_prs: 0, median_size: null },
    '/me/since': {
      since: null,
      first_visit: true,
      review_requests: 0,
      prs_advanced: 0,
      findings_on_my_prs: 0,
    },
  };
  useApiQuery.mockImplementation((d: { endpoint: string }) => ({
    data: byEndpoint[d.endpoint],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }));
  return render(<MyFocus search={{}} />);
}

const table = (name: string) => screen.getByTestId(`table-${name}`);

describe('My Focus row identity across repositories', () => {
  it('tells apart two of my pull requests that share a number', () => {
    renderWith({ prs: [pr(1, 'web', 5), pr(2, 'api', 5)] });
    const rows = within(table('my-prs')).getAllByTestId(/^row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('acme/web');
    expect(rows[1]!.textContent).toContain('acme/api');
    expect(rows[0]!.textContent).not.toBe(rows[1]!.textContent);
  });

  it('tells apart three review-queue entries that share a number', () => {
    renderWith({ queue: [review(1, 'web', 4), review(2, 'api', 4), review(3, 'worker', 4)] });
    const text = within(table('review-queue'))
      .getAllByTestId(/^row-/)
      .map((r) => r.textContent ?? '');
    expect(text).toHaveLength(3);
    expect(new Set(text).size).toBe(3);
    expect(text.join('|')).toContain('acme/worker');
  });

  it('calls the queue what it is, not "awaiting my review" (W20-09, DSH-85)', () => {
    renderWith({ queue: [review(1, 'web', 4)] });
    expect(
      within(table('review-queue')).getByRole('columnheader', { name: 'Open PRs by others' }),
    ).toBeTruthy();
    expect(screen.queryByText('Awaiting my review')).toBeNull();
    expect(screen.getByText(/Open PRs by others you haven't reviewed/)).toBeTruthy();
  });

  it('tells apart two owned files with the same path', () => {
    renderWith({ hotspots: [owned(1, 'web', 'src/mod0.ts'), owned(2, 'api', 'src/mod0.ts')] });
    const text = within(table('my-hotspots'))
      .getAllByTestId(/^row-/)
      .map((r) => r.textContent ?? '');
    expect(new Set(text).size).toBe(2);
  });

  it('decides the column per LIST, not per screen', () => {
    // Someone whose own PRs all live in one repo but who reviews across four
    // should get the column on exactly the list that needs it.
    renderWith({
      prs: [pr(1, 'web', 5), pr(1, 'web', 6)],
      queue: [review(1, 'web', 4), review(2, 'api', 4)],
    });
    expect(within(table('my-prs')).queryByRole('columnheader', { name: 'Repository' })).toBeNull();
    expect(
      within(table('review-queue')).getByRole('columnheader', { name: 'Repository' }),
    ).toBeTruthy();
  });

  it('keeps the metric on the row when the column is added', () => {
    renderWith({ hotspots: [owned(1, 'web', 'src/mod0.ts'), owned(2, 'api', 'src/mod0.ts')] });
    const first = within(table('my-hotspots')).getAllByTestId(/^row-/)[0]!;
    expect(first.textContent).toContain('acme/web');
    expect(within(first).getByText('120')).toBeTruthy();
  });
});

// W16-51. The "Open PRs" tile counted the whole /me/prs list, which comes back
// in EVERY state — so it read 2 above a table showing one open PR and one
// merged one. My Focus exists to say what is on your plate, and a merged pull
// request is not on anyone's plate.
describe('the Open PRs tile (W16-51)', () => {
  const merged = (id: number, name: string, number: number): MyPr => ({
    ...pr(id, name, number),
    state: 'merged',
    merged_at: '2026-08-20T00:00:00.000Z',
  });

  /** The "Open PRs" tile, found by its label among the KPI tiles. */
  function openPrTile(): HTMLElement {
    const tile = screen
      .getAllByTestId('kpi-tile')
      .find((el) => el.textContent?.includes('Open PRs'));
    if (!tile) throw new Error('no Open PRs tile rendered');
    return tile;
  }

  it('counts only the open ones', () => {
    renderWith({ prs: [pr(1, 'web', 5), merged(2, 'api', 3)] });
    expect(openPrTile().textContent).toContain('1');
  });

  it('reads zero when every pull request of mine is already merged', () => {
    renderWith({ prs: [merged(1, 'web', 1), merged(2, 'api', 2)] });
    // …and the table is still not empty, which is the case the old empty
    // message ("Nothing open — you have no pull requests in flight") described
    // wrongly: those authors have pull requests, just none open.
    expect(openPrTile().textContent).toContain('0');
    expect(within(table('my-prs')).getAllByRole('row').length).toBeGreaterThan(1);
  });
});
