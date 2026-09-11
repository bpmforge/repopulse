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

export function HealthTileGrid({ window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<HealthTiles>({
    endpoint: '/org/health-tiles',
    query: { window },
  });
  const repoProgress = useUiStore((s) => s.repoProgress);
  const connection = useUiStore((s) => s.sseConnection);

  const items = data?.items ?? [];
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && items.length === 0,
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
                  <span className="truncate font-medium">{repo.name}</span>
                  {progress ? (
                    <SyncStatusChip connection={connection} progress={progress} />
                  ) : (
                    <HealthBadge score={repo.health.score} />
                  )}
                </div>
                <p className="mt-1 text-xs text-fg-muted">
                  {progress ? 'Backfilling — score pending' : `Basis: ${repo.health.basis}`}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </WidgetFrame>
  );
}
