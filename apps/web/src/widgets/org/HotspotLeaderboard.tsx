import { Link } from '@tanstack/react-router';
import {
  DataTable,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { spansMultipleRepos, type HotspotItems } from './contracts.js';
import { docsUrl } from '../../lib/docs.js';
import { HOTSPOT_SCALE_HINT } from '../repo/RepoHotspots.js';

// UX_SPEC §4.a: cross-repo hotspot leaderboard, click → file drill-down
// (W4-06's /repos/$repoId/files/$). The file path is a splat param, so it is
// passed whole rather than segment-encoded.

interface Props {
  window: string;
  search: Record<string, string>;
  limit?: number;
}

type Row = HotspotItems['items'][number];

export function HotspotLeaderboard({ window, search, limit = 10 }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<HotspotItems>({
    endpoint: '/hotspots',
    // The view's or topbar's repo scope (W20-05, UX_TODO DSH-02).
    query: {
      window,
      limit,
      ...(search.repos && search.repos !== 'all' ? { repos: search.repos } : {}),
    },
  });

  const items = data?.items ?? [];
  // src/index.ts is hot in three repositories and the leaderboard listed it
  // three times, identically — the score told you something was wrong without
  // telling you where. The repository is part of the row's identity here.
  const showRepo = spansMultipleRepos(items);
  const columns: DataTableColumn<Row>[] = [
    {
      id: 'path',
      header: 'File',
      cell: (row) => (
        <Link
          to="/repos/$repoId/files/$"
          params={{ repoId: String(row.repoId), _splat: row.path } as never}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid={`hotspot-${row.repoId}-${row.path}`}
        >
          {row.path}
        </Link>
      ),
    },
    ...(showRepo
      ? [
          {
            id: 'repo',
            header: 'Repository',
            // Findings' weight: secondary to the linked path, never competing
            // with it, and never wide enough to push the score off the row.
            cell: (row: Row) => (
              <span className="text-xs whitespace-nowrap text-fg-muted">
                {row.repo.org}/{row.repo.name}
              </span>
            ),
          } satisfies DataTableColumn<Row>,
        ]
      : []),
    {
      id: 'score',
      // W20-12 (UX_TODO DSH-79): each score is normalised within ITS OWN
      // repository, so the header says so — a quiet repository's busiest file
      // scores near 1 too, and a cross-repository ranking is not a comparison
      // of absolute churn. The lines-changed column beside it is.
      header: 'Hotspot score (within its repository)',
      align: 'right',
      sortable: true,
      // Scores are 0–1 (METRICS M2: normChurn × decay); two decimals keeps
      // neighbouring files distinguishable without implying false precision.
      cell: (row) => (
        <span className="tabular-nums" title={HOTSPOT_SCALE_HINT}>
          {row.score.toFixed(2)}
        </span>
      ),
    },
    {
      // W20-12 (UX_TODO DSH-20/79): the score's main part in absolute terms,
      // comparable across repositories where the score is not.
      id: 'gross',
      header: 'Lines changed',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.gross ?? '—'}</span>,
    },
  ];

  return (
    <WidgetFrame
      title="Hotspots"
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && items.length === 0,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No churn in this window — nothing is hot."
      definitionHref={docsUrl('/docs/design/METRICS.md')}
    >
      <div data-testid="hotspot-leaderboard">
        {/* The honesty badge (W6-09). Rendered only when something IS hidden,
            so the common case stays quiet — but never silent when it matters. */}
        {(data?.suppressed_count ?? 0) > 0 && (
          <p className="mb-2 text-xs text-fg-muted" data-testid="hotspot-suppressed">
            {data?.suppressed_count} acknowledged file
            {data?.suppressed_count === 1 ? '' : 's'} hidden from this list
            {data?.suppressed_paths && data.suppressed_paths.length > 0
              ? `: ${data.suppressed_paths.join(', ')}`
              : ''}
          </p>
        )}
        <DataTable
          name="org-hotspots"
          columns={columns}
          data={items}
          getRowId={(row) => `${row.repoId}:${row.path}`}
        />
      </div>
    </WidgetFrame>
  );
}
