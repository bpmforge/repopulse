import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Chart,
  DataTable,
  WidgetFrame,
  frameState,
  useChartThemeKey,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { docsUrl } from '../../lib/docs.js';
import { sequentialColor } from '../../components/chart/chartTheme.js';
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

/** How many rows "Top files" shows before "Show all" (W20-12, DSH-22). */
const TOP_FILES = 20;

/**
 * What the 0–1 score means, said once and reused as the column's tooltip on
 * every hotspot list (W20-12, UX_TODO DSH-20).
 */
export const HOTSPOT_SCALE_HINT =
  'Hotspot score, 0–1: lines changed relative to the busiest file in this repository, halved for every 30 days since the last change.';

export function RepoHotspotsTab({ repoId, window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoHotspotsResponse>({
    endpoint: '/repos/{id}/hotspots',
    path: { id: repoId },
    query: { window },
  });

  const items = data?.items ?? [];
  const tree = toTreemap(items);
  useChartThemeKey();
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, TOP_FILES);

  // A HEAT MAP WITH HEAT (W16-43).
  //
  // Every tile took the theme's first series colour, so a file scoring 0.82
  // was painted exactly like one scoring 0.10: the map encoded size and threw
  // the score away, and a reader would reasonably conclude every file was
  // equally hot. Colour is the one channel a treemap has left after area.
  //
  // Painted per node rather than through a `visualMap`, because a treemap
  // ignores one — it has its own levels/colorMappingBy machinery, so a
  // visualMap silently does nothing (tried, and the tiles stayed flat).
  //
  // Sequential and single-hue because a hotspot score is a MAGNITUDE. The
  // status palette is deliberately not borrowed: ok/warn/crit mean a state
  // someone should act on, and a churned file is not thereby critical.
  //
  // A DIRECTORY takes its hottest child's colour, not its own value — that
  // value is the SUM of its children and routinely exceeds 1, so mapping it
  // would paint every directory at the top of the ramp. "How hot is this
  // directory" means its worst file, which is also the question someone
  // scanning the map is asking.
  //
  // Recomputed when the theme flips (`useChartThemeKey`) — these colours are
  // baked into the option literal, so without that signal a light-mode ramp
  // survived the switch to dark.
  const painted = tree.map((dir) => ({
    ...dir,
    itemStyle: { color: sequentialColor(Math.max(...dir.children.map((c) => c.score), 0)) },
    children: dir.children.map((leaf) => ({
      ...leaf,
      // Colour is the SCORE; area (value) is churn since W20-12 (DSH-21).
      itemStyle: { color: sequentialColor(leaf.score) },
    })),
  }));
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
      cell: (row) => (
        <span className="tabular-nums" title={HOTSPOT_SCALE_HINT}>
          {row.hotspot_score.toFixed(2)}
        </span>
      ),
    },
    // W20-12 (UX_TODO DSH-20): the score's parts and who holds the file, so
    // a high number explains itself and names who to talk to.
    {
      id: 'churn',
      header: 'Lines changed',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">{row.decomposition ? row.decomposition.gross : '—'}</span>
      ),
    },
    {
      id: 'since',
      header: 'Last change',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums whitespace-nowrap">
          {row.decomposition ? `${Math.round(row.decomposition.daysSince)}d ago` : '—'}
        </span>
      ),
    },
    {
      id: 'owner',
      header: 'Top owner',
      cell: (row) =>
        row.top_owner ? (
          <span className="whitespace-nowrap text-xs text-fg-muted" data-testid="hotspot-owner">
            {row.top_owner.login} · {Math.round(row.top_owner.share * 100)}%
          </span>
        ) : (
          <span className="text-fg-faint">—</span>
        ),
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
        definitionHref={docsUrl('/docs/design/METRICS.md')}
      >
        <p className="mb-1 text-xs text-fg-faint">
          Box size is lines changed; colour is the hotspot score. Click a file to open it.
        </p>
        <Chart
          testId="hotspot-treemap"
          ariaLabel={`Hotspot treemap by directory, sized by lines changed and coloured by score, last ${window}`}
          height={320}
          // The table fallback is the whole accessibility story for a treemap:
          // size-encoded data is unreadable without one (NFR-5).
          tableData={{
            columns: ['File', 'Hotspot score', 'Lines changed'],
            rows: items.map((i) => [
              i.path,
              Number(i.hotspot_score.toFixed(2)),
              i.decomposition?.gross ?? '—',
            ]),
          }}
          // W20-12 (UX_TODO DSH-21): a FILE opens its page; a directory still
          // zooms (ECharts' nodeClick). Only leaves carry a `path`.
          onEvents={{
            click: (params: unknown) => {
              const path = (params as { data?: { path?: string } }).data?.path;
              if (!path) return;
              void navigate({
                to: '/repos/$repoId/files/$',
                params: { repoId, _splat: path } as never,
                search: search as never,
              });
            },
          }}
          option={{
            tooltip: { trigger: 'item' },
            series: [
              {
                type: 'treemap',
                roam: false,
                nodeClick: 'zoomToNode',
                breadcrumb: { show: true },
                data: painted,
              },
            ],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        // W20-12 (UX_TODO DSH-22): the cut is stated, and the rest one click away.
        title={
          items.length > TOP_FILES && !showAll
            ? `Top ${TOP_FILES} of ${items.length} files`
            : `Top files (${items.length})`
        }
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No ranked files yet."
        drillDown={
          items.length > TOP_FILES ? (
            <button
              type="button"
              className="text-xs text-accent underline-offset-2 hover:underline"
              onClick={() => setShowAll((v) => !v)}
              data-testid="hotspots-show-all"
            >
              {showAll ? `Show top ${TOP_FILES}` : `Show all ${items.length}`}
            </button>
          ) : undefined
        }
      >
        <div className="overflow-x-auto">
          <DataTable
            name="repo-hotspots"
            columns={columns}
            data={shown}
            getRowId={(row) => row.path}
          />
        </div>
      </WidgetFrame>
    </div>
  );
}
