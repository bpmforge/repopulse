import { Link } from '@tanstack/react-router';
import {
  Chart,
  DataTable,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { toTreemap, type RepoHotspots as RepoHotspotsResponse } from './contracts.js';

// Hotspots tab (UX_SPEC §4.b, FR-WEB-3): directory treemap sized by hotspot
// score, plus the side top-N list. Clicking a file goes to the drill-down
// (W4-06's route); clicking a directory zooms, which ECharts' treemap gives us
// natively rather than through bespoke state.

interface Props {
  repoId: string;
  window: string;
  search: Record<string, string>;
}

type Row = RepoHotspotsResponse['items'][number];

export function RepoHotspotsTab({ repoId, window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoHotspotsResponse>({
    endpoint: '/repos/{id}/hotspots',
    path: { id: repoId },
    query: { window },
  });

  const items = data?.items ?? [];
  const tree = toTreemap(items);
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && items.length === 0,
  });

  const columns: DataTableColumn<Row>[] = [
    {
      id: 'path',
      header: 'File',
      cell: (row) => (
        <Link
          to="/repos/$repoId/files/$"
          params={{ repoId, _splat: row.path } as never}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {row.path}
        </Link>
      ),
    },
    {
      id: 'score',
      header: 'Hotspot',
      align: 'right',
      sortable: true,
      // M2 is normChurn × decay on 0..1. Two decimals separates neighbouring
      // files without implying precision the formula does not have.
      cell: (row) => <span className="tabular-nums">{row.hotspot_score.toFixed(2)}</span>,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]" data-testid="repo-hotspots">
      <WidgetFrame
        title="Hotspot map"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No churn in this window — nothing is hot."
      >
        <Chart
          testId="hotspot-treemap"
          ariaLabel={`Hotspot treemap by directory, last ${window}`}
          height={320}
          // The table fallback is the whole accessibility story for a treemap:
          // size-encoded data is unreadable without one (NFR-5).
          tableData={{
            columns: ['File', 'Hotspot score'],
            rows: items.map((i) => [i.path, Number(i.hotspot_score.toFixed(2))]),
          }}
          option={{
            tooltip: { trigger: 'item' },
            series: [
              {
                type: 'treemap',
                roam: false,
                nodeClick: 'zoomToNode',
                breadcrumb: { show: true },
                data: tree,
              },
            ],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="Top files"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No ranked files yet."
      >
        <DataTable
          name="repo-hotspots"
          columns={columns}
          data={items.slice(0, 20)}
          getRowId={(row) => row.path}
        />
      </WidgetFrame>
    </div>
  );
}
