import { Link } from '@tanstack/react-router';
import {
  DataTable,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { spansMultipleRepos, type HotspotItems } from './contracts.js';

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
    query: { window, limit },
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
      header: 'Hotspot score',
      align: 'right',
      sortable: true,
      // Scores are 0–1 (METRICS M2: normChurn × decay); two decimals keeps
      // neighbouring files distinguishable without implying false precision.
      cell: (row) => <span className="tabular-nums">{row.score.toFixed(2)}</span>,
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
