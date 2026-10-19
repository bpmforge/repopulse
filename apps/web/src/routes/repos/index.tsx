import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { HealthBadge, PageHeader, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { forgeLabel } from '../../widgets/repo/contracts.js';

// Repo list — the breadcrumb's middle rung. Org Overview links straight to a
// repo, but a pasted /repos URL has to land somewhere real rather than the
// not-found placeholder (FR-WEB-2, "no dead ends").
//
// W17-18 rebuilt what it shows. Four things were wrong with the version that
// read /org/health-tiles:
//   1. it rendered `repo.name` alone, and health-tiles carries no org, so two
//      repositories called `api` in different orgs were two identical rows;
//   2. it had no order at all — whatever the API returned — and no way to ask
//      for one;
//   3. the `?repos=` filter it applied compared the whole CSV to one id, so
//      `?repos=1,2` matched nothing and reported an empty workspace;
//   4. "No repositories connected yet." was shown for a filter that matched
//      nothing, which is a different fact and a different fix.
// It now reads GET /repos, which returns org + name + health in one bounded
// request (never one per row).

interface RepoRow {
  id: number;
  org: string;
  name: string;
  /** Which forge and host (W20-15, UX_TODO X-16). Optional for an older API. */
  forge?: { provider: string; host: string | null } | null;
  /** The same org/name is tracked through another connection too. */
  tracked_twice?: boolean;
  sync: string;
  health: {
    /** null when nothing has been measured — NOT a zero (W17-18, API side). */
    score: number | null;
    letter: string | null;
    measured: boolean;
    basis: string;
  };
}

const SORTS = ['name:asc', 'name:desc', 'health:desc', 'health:asc'] as const;
type RepoSort = (typeof SORTS)[number];
const DEFAULT_SORT: RepoSort = 'name:asc';

const SORT_LABEL: Record<RepoSort, string> = {
  'name:asc': 'Name (A–Z)',
  'name:desc': 'Name (Z–A)',
  'health:desc': 'Health (best first)',
  'health:asc': 'Health (worst first)',
};

export interface RepoListSearch {
  sort?: RepoSort;
  q?: string;
}

/**
 * This screen's own view state, in the URL (FR-WEB-2: a pasted URL restores
 * the identical screen, and so does the back button after a drill-down).
 *
 * Lenient like the root's validateSearch and the findings explorer's: a junk
 * `?sort=` falls back to the default rather than white-screening the list.
 */
function validateRepoListSearch(search: Record<string, unknown>): RepoListSearch {
  const out: RepoListSearch = {};
  if (typeof search.sort === 'string' && (SORTS as readonly string[]).includes(search.sort)) {
    out.sort = search.sort as RepoSort;
  }
  if (typeof search.q === 'string' && search.q.trim().length > 0) out.q = search.q;
  return out;
}

export const Route = createFileRoute('/repos/')({
  validateSearch: validateRepoListSearch,
  component: RepoList,
});

/**
 * Order the rows, with UNKNOWN health partitioned out rather than coalesced.
 *
 * `(a.score ?? 0) - (b.score ?? 0)` looks like it works and is the bug: it
 * ranks a repository nobody has ingested as the least healthy thing in the
 * workspace. Unmeasured repos sort last in BOTH directions — they are not at
 * either end of the scale, they are off it — and tie-break by name so the
 * order is stable rather than whatever Postgres returned.
 */
export function sortRepos(rows: RepoRow[], sort: RepoSort): RepoRow[] {
  const [key, dir] = sort.split(':') as ['name' | 'health', 'asc' | 'desc'];
  const byName = (a: RepoRow, b: RepoRow) =>
    `${a.org}/${a.name}`.localeCompare(`${b.org}/${b.name}`);
  return [...rows].sort((a, b) => {
    if (key === 'name') return dir === 'asc' ? byName(a, b) : -byName(a, b);
    const aScore = a.health.measured ? a.health.score : null;
    const bScore = b.health.measured ? b.health.score : null;
    if (aScore === null || bScore === null) {
      if (aScore === bScore) return byName(a, b);
      return aScore === null ? 1 : -1;
    }
    if (aScore === bScore) return byName(a, b);
    return dir === 'asc' ? aScore - bScore : bScore - aScore;
  });
}

/** The topbar's `?repos=` is a CSV of ids, or the sentinel `all` (urlState). */
export function selectedRepoIds(repos: string | undefined): Set<string> | null {
  if (!repos || repos === 'all') return null;
  const ids = repos
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

function RepoList() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const preserved = serializeGlobalSearch(search);
  const sort = search.sort ?? DEFAULT_SORT;
  const q = search.q ?? '';

  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: RepoRow[] }>({
    endpoint: '/repos',
    query: { window: search.window },
  });

  const allItems = data?.items ?? [];
  // Both filters are applied in the browser on purpose: /repos is one bounded
  // request for the whole workspace and the shell already holds it in cache, so
  // narrowing it costs nothing and adds no round trip per keystroke.
  const selected = selectedRepoIds(search.repos);
  const needle = q.trim().toLowerCase();
  const items = sortRepos(
    allItems.filter(
      (r) =>
        (selected === null || selected.has(String(r.id))) &&
        (needle === '' || `${r.org}/${r.name}`.toLowerCase().includes(needle)),
    ),
    sort,
  );

  const filtering = selected !== null || needle !== '';
  const isEmpty = data !== undefined && items.length === 0;
  // The two empty states are different facts. "Nothing is connected" needs a
  // way to connect something; "nothing matched" needs a way to stop matching.
  const filteredToNothing = isEmpty && filtering && allItems.length > 0;

  const patchSearch = (patch: RepoListSearch) => {
    void navigate({
      to: '/repos',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        // Defaults stay OUT of the URL (DASHBOARD §1).
        if (next.sort === DEFAULT_SORT) delete next.sort;
        if (typeof next.q === 'string' && next.q.trim() === '') delete next.q;
        return next;
      },
      // A keystroke is not a history entry — otherwise the back button walks
      // the user letter by letter back out of what they typed.
      replace: true,
    } as never);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Repositories"
        description="Every tracked repository and its health signal, worst first when sorted by score."
      />
      <WidgetFrame
        title="Tracked repositories"
        state={frameState({ isLoading, isError, isEmpty })}
        // The error object rather than `error.message`: it derives BOTH the
        // sentence and the request id, and the explicit prop suppressed the id
        // (W16-18).
        {...(error ? { error } : {})}
        onRetry={() => void refetch()}
        emptyMessage={
          filteredToNothing
            ? `No repositories match ${needle === '' ? 'the current filter' : `“${q}”`}.`
            : 'No repositories connected yet.'
        }
        emptyAction={
          filteredToNothing ? (
            <button
              type="button"
              data-testid="repo-list-clear-filter"
              onClick={() => void navigate({ to: '/repos', search: {} as never })}
              className="rounded-sm border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Clear filters
            </button>
          ) : (
            <Link
              to="/setup"
              data-testid="repo-list-connect"
              className="rounded-sm border border-border px-2 py-1 text-xs text-fg hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Connect a forge
            </Link>
          )
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="repo-list-filter" className="text-xs text-fg-muted">
                Filter by name or org
              </label>
              <input
                id="repo-list-filter"
                data-testid="repo-list-filter"
                type="search"
                value={q}
                onChange={(e) => patchSearch({ q: e.target.value })}
                placeholder="acme/api"
                className="w-full panel-inset px-2 py-1 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="repo-list-sort" className="text-xs text-fg-muted">
                Sort
              </label>
              <select
                id="repo-list-sort"
                data-testid="repo-list-sort"
                value={sort}
                onChange={(e) => patchSearch({ sort: e.target.value as RepoSort })}
                className="panel-inset px-2 py-1 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* W16-05 (F20). The badge carried a good aria-label all along, so a
            screen reader always heard "health score 39 of 100, needs attention" —
            but a sighted reader got a bare coloured number with no header and no
            legend anywhere on the screen. The repo page pairs the same number with
            a "why?" link and a "4 not measured" caveat; the list dropped both. */}
          <div className="flex items-center justify-between px-3 text-xs text-fg-muted">
            <span>Repository</span>
            <span>Health score (0–100)</span>
          </div>

          {/* W20-15 (UX_TODO X-16): a repository mirrored on two forges is
              tracked twice, and its commits, PRs and findings count twice in
              every org number. Said once, here, with the way out. */}
          {items.some((r) => r.tracked_twice) && (
            <p
              role="status"
              className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
              data-testid="repo-list-duplicates"
            >
              Tracked through more than one connection:{' '}
              {[...new Set(items.filter((r) => r.tracked_twice).map((r) => `${r.org}/${r.name}`))]
                .slice(0, 5)
                .join(', ')}
              . Each one&apos;s activity is counted twice in organisation numbers; an admin can
              pause the copy you do not want in Settings → Sync.
            </p>
          )}

          <ul className="flex flex-col gap-2" data-testid="repo-list">
            {items.map((repo) => (
              <li key={repo.id}>
                <Link
                  to="/repos/$repoId"
                  params={{ repoId: String(repo.id) }}
                  search={preserved as never}
                  data-testid={`repo-row-${repo.id}`}
                  // The full path, for the case truncation eats one end of it.
                  title={`${repo.org}/${repo.name}`}
                  className="flex items-center justify-between gap-2 panel px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="flex min-w-0 flex-col">
                    {/* Org FIRST and quiet, name second and prominent: the org
                      is what disambiguates, the name is what is being looked
                      for, and `truncate` clips the right-hand end — so the
                      name must not share a line with anything. */}
                    <span className="truncate text-xs text-fg-muted" data-testid="repo-row-org">
                      {repo.org}
                      {repo.forge && (
                        <span data-testid="repo-row-forge">
                          {' · '}
                          {forgeLabel(repo.forge)}
                        </span>
                      )}
                    </span>
                    <span className="truncate" data-testid="repo-row-name">
                      {repo.name}
                    </span>
                  </span>
                  <HealthBadge score={repo.health.measured ? repo.health.score : null} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </WidgetFrame>
    </div>
  );
}
