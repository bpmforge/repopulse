import { Link } from '@tanstack/react-router';
import {
  HealthBadge,
  SyncStatusChip,
  WidgetFrame,
  frameState,
  useUiStore,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { HealthTiles } from './contracts.js';

// UX_SPEC §4.a: per-repo health grid, click → repo (W4-04's /repos/$repoId).
//
// Backfilling repos render a syncing chip with its percentage and NEVER a zero
// (UX_SPEC §8 / E3.6): a health score of 0 on a repo that simply has not been
// ingested yet is indistinguishable from a genuinely unhealthy repo, and the
// second reading is the damaging one. Progress comes from the SSE store, so a
// repo mid-backfill shows phase + % instead of a number.

interface Props {
  window: string;
  search: Record<string, string>;
}

/**
 * How many tiles the card shows (W20-05, UX_TODO X-05). At 500 repositories
 * the card rendered 500 tiles in database order; the API now sends them worst
 * first, so the first dozen ARE the ones to look at, and the rest are one
 * click away in Repositories.
 */
export const HEALTH_TILE_CAP = 12;

export function HealthTileGrid({ window, search }: Props) {
  // The view's or the topbar's repo scope reaches the query (W20-05, UX_TODO
  // DSH-02): a saved view of three repositories shows those three.
  const repos = search.repos && search.repos !== 'all' ? search.repos : undefined;
  const { data, isLoading, isError, error, refetch } = useApiQuery<HealthTiles>({
    endpoint: '/org/health-tiles',
    query: { window, ...(repos ? { repos } : {}) },
  });
  const repoProgress = useUiStore((s) => s.repoProgress);
  const connection = useUiStore((s) => s.sseConnection);

  const all = data?.items ?? [];
  const items = all.slice(0, HEALTH_TILE_CAP);
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && all.length === 0,
    isSyncing: Object.keys(repoProgress).length > 0,
  });

  return (
    <WidgetFrame
      title="Repo health"
      state={state}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No repositories in this workspace yet."
    >
      <ul
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="health-tile-grid"
      >
        {items.map((repo) => {
          const progress = repoProgress[repo.id];
          return (
            <li key={repo.id}>
              <Link
                to="/repos/$repoId"
                params={{ repoId: String(repo.id) }}
                search={search as never}
                className="block panel p-3 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`health-tile-${repo.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* org/name (X-05): `api` in two orgs looked identical. */}
                  <span className="truncate font-medium" title={`${repo.org}/${repo.name}`}>
                    <span className="font-normal text-fg-muted">{repo.org}/</span>
                    {repo.name}
                  </span>
                  {progress ? (
                    <SyncStatusChip connection={connection} progress={progress} />
                  ) : (
                    // Unmeasured is "—", like /repos — never a red 0 (DSH-08).
                    <HealthBadge score={repo.health.measured ? repo.health.score : null} />
                  )}
                </div>
                <p className="mt-1 text-xs text-fg-muted">
                  {progress
                    ? 'Backfilling — score pending'
                    : repo.health.measured
                      ? `Basis: ${repo.health.basis}`
                      : 'Not measured yet'}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
      {all.length > items.length && (
        <p className="mt-3 text-xs text-fg-muted">
          Showing the {items.length} lowest-scoring of {all.length}.{' '}
          <Link
            to="/repos"
            search={{ ...search, sort: 'health:asc' } as never}
            className="text-accent hover:underline"
            data-testid="health-see-all"
          >
            See all {all.length} in Repositories
          </Link>
        </p>
      )}
    </WidgetFrame>
  );
}
