import {
  Chart,
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  SINGLE_OWNER_THRESHOLD,
  toWeeklyChurn,
  type FileDetail as FileDetailResponse,
} from './contracts.js';

// File drill-down (UX_SPEC §4.d): 52-week churn bars and the owners list with
// the M3 single-owner flag.

interface Props {
  repoId: string;
  path: string;
}

type OwnerRow = FileDetailResponse['owners'][number];

export function FileDetailScreen({ repoId, path }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<FileDetailResponse>({
    endpoint: '/repos/{id}/files/{path}',
    path: { id: repoId, path },
  });

  const weeks = data ? toWeeklyChurn(data.churn_series, Date.now()) : [];
  const topShare = data?.owners[0]?.share ?? 0;
  const singleOwner = topShare >= SINGLE_OWNER_THRESHOLD;

  const ownerColumns: DataTableColumn<OwnerRow>[] = [
    { id: 'login', header: 'Author', cell: (row) => row.login },
    {
      id: 'lines',
      header: 'Lines changed',
      align: 'right',
      sortable: true,
      cell: (row) => <span className="tabular-nums">{row.lines_changed}</span>,
    },
    {
      id: 'share',
      header: 'Share',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{Math.round(row.share * 100)}%</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="file-detail">
      <header className="flex flex-wrap items-baseline gap-3">
        {/* R-D1: mono is for IDENTIFIERS — paths, SHAs, code evidence — and a
            file path is the archetypal one. Numerals stay on Inter with
            tabular-nums (set globally in theme.css), which is the other half of
            the same rule. */}
        <h1 className="truncate font-mono text-lg font-semibold" data-testid="file-path">
          {data?.path ?? path}
        </h1>
        {singleOwner && (
          <span className="flex items-center gap-1.5" data-testid="single-owner-flag">
            <SeverityBadge severity="medium" />
            <span className="text-xs text-fg-muted">
              single owner — {Math.round(topShare * 100)}% of changed lines
            </span>
          </span>
        )}
      </header>

      <WidgetFrame
        title="Churn, last 52 weeks"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && data.churn_series.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No non-merge commits touched this file."
      >
        <Chart
          testId="file-churn"
          ariaLabel={`Weekly churn for ${path}, last 52 weeks`}
          height={220}
          tableData={{
            columns: ['Week', 'Gross', 'Net'],
            rows: weeks.map((w) => [w.week, w.gross, w.net]),
          }}
          option={{
            grid: { left: 48, right: 12, top: 24, bottom: 32 },
            legend: { data: ['Gross', 'Net'] },
            xAxis: { type: 'category', data: weeks.map((w) => w.week) },
            yAxis: { type: 'value' },
            tooltip: { trigger: 'axis' },
            series: [
              { name: 'Gross', type: 'bar', data: weeks.map((w) => w.gross) },
              { name: 'Net', type: 'bar', data: weeks.map((w) => w.net) },
            ],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="Owners"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && data.owners.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No authorship recorded for this file."
      >
        <div data-testid="file-owners">
          <DataTable
            name="file-owners"
            columns={ownerColumns}
            data={data?.owners ?? []}
            getRowId={(row) => row.login}
          />
        </div>
      </WidgetFrame>

      <WidgetFrame
        title="Findings"
        state="empty"
        emptyMessage="File-scoped findings arrive with Tier-2 analysis (wave W6)."
      />

      <WidgetFrame
        title="Rework, hotspot history, recent PRs, rename chain"
        state="empty"
        // Named, not silently omitted: each needs API data this endpoint does
        // not return. Drawing gross churn labelled "rework", or a flat line
        // labelled "hotspot history", would misstate the metric rather than
        // admit the gap.
        emptyMessage="Not available yet — each needs API data this endpoint does not return (M1's rework component, hotspot-score history, per-file PR list, and previousPath rename metadata). Tracked as W4-17."
      />
    </div>
  );
}
