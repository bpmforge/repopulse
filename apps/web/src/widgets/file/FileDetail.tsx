import {
  Chart,
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { Link } from '@tanstack/react-router';
import { useApiQuery } from '../../api/useApiQuery.js';
import { IntentControl } from './IntentControl.js';
import {
  SINGLE_OWNER_THRESHOLD,
  STALE_FILE_DAYS,
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

  // The API's buckets. The browser-side version was deleted rather than kept
  // alongside: REWORK cannot be computed here at all — M1 scopes it to a prior
  // non-bot touch <21d earlier across the rename chain, and the per-commit
  // series carries neither bot flags nor old paths.
  const weeks = data?.weekly_churn ?? [];
  const topShare = data?.owners[0]?.share ?? 0;
  const lastSeenMs = data?.last_seen_at ? new Date(data.last_seen_at).getTime() : null;
  const staleFile =
    lastSeenMs !== null && Date.now() - lastSeenMs > STALE_FILE_DAYS * 24 * 60 * 60 * 1000;
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
      {/* W6-09: the intent control sits at the top, because deciding what a
          team means to do about a file is context for every number below it. */}
      <IntentControl repoId={Number(repoId)} path={path} />
      {/* UX_SPEC §4.d's deleted/renamed banner. It reports what the warehouse
          knows — the last date we saw a touch, and the paths this file was
          known by — and does NOT claim the file was deleted, because ingestion
          cannot distinguish a deletion from a quiet file. */}
      {(staleFile || (data?.previous_paths.length ?? 0) > 0) && (
        <div
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-fg-muted"
          role="note"
          data-testid="file-history-banner"
        >
          {staleFile && data?.last_seen_at && (
            <span>Last seen {data.last_seen_at.slice(0, 10)}. </span>
          )}
          {(data?.previous_paths.length ?? 0) > 0 && (
            <span>
              Previously:{' '}
              {data!.previous_paths.map((p) => (
                <code key={`${p.path}-${p.renamed_at}`} className="font-mono">
                  {p.path}
                </code>
              ))}
            </span>
          )}
        </div>
      )}

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
            columns: ['Week', 'Gross', 'Net', 'Rework'],
            rows: weeks.map((w) => [w.week, w.gross, w.net, w.rework]),
          }}
          option={{
            grid: { left: 48, right: 12, top: 24, bottom: 32 },
            legend: { data: ['Gross', 'Net', 'Rework'] },
            xAxis: { type: 'category', data: weeks.map((w) => w.week) },
            yAxis: { type: 'value' },
            tooltip: { trigger: 'axis' },
            series: [
              { name: 'Gross', type: 'bar', data: weeks.map((w) => w.gross) },
              { name: 'Net', type: 'bar', data: weeks.map((w) => w.net) },
              // Rework is a SUBSET of gross, so it is drawn as its own bar
              // rather than stacked on top — stacking would imply gross + rework
              // is a total, and read as double the churn that actually happened.
              { name: 'Rework', type: 'bar', data: weeks.map((w) => w.rework) },
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
        title="Hotspot score history"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && data.hotspot_history.length < 2,
        })}
        onRetry={() => void refetch()}
        definitionHref="/docs/design/METRICS.md"
        // A single point is not a history. The empty state that stood here said
        // a flat line drawn from one current value would invent a trend — so
        // fewer than two points stays empty rather than becoming that line.
        emptyMessage="Needs at least two snapshots — the history builds up as nightly runs accumulate."
      >
        <Chart
          testId="file-hotspot-history"
          ariaLabel={`Hotspot score history for ${path}`}
          height={120}
          tableData={{
            columns: ['Date', 'Hotspot score'],
            rows: (data?.hotspot_history ?? []).map((h) => [h.computed_at.slice(0, 10), h.score]),
          }}
          option={{
            grid: { left: 40, right: 12, top: 12, bottom: 24 },
            xAxis: {
              type: 'category',
              data: (data?.hotspot_history ?? []).map((h) => h.computed_at.slice(0, 10)),
            },
            yAxis: { type: 'value' },
            tooltip: { trigger: 'axis' },
            series: [
              {
                type: 'line',
                smooth: true,
                showSymbol: false,
                data: (data?.hotspot_history ?? []).map((h) => h.score),
              },
            ],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="Pull requests touching this file"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && data.prs.length === 0,
        })}
        onRetry={() => void refetch()}
        emptyMessage="No pull request in the warehouse lists this path. A PR that touched it under an earlier name is filed under that path instead."
      >
        <ul className="flex flex-col gap-1 text-sm" data-testid="file-prs">
          {(data?.prs ?? []).map((pr) => (
            <li key={pr.number} className="flex items-baseline gap-2">
              <Link
                to="/repos/$repoId/prs/$number"
                params={{ repoId, number: String(pr.number) }}
                className="text-accent hover:underline"
              >
                #{pr.number}
              </Link>
              <span className="truncate">{pr.title}</span>
              <span className="ml-auto shrink-0 text-xs text-fg-muted">
                {pr.author} · {pr.state}
              </span>
            </li>
          ))}
        </ul>
      </WidgetFrame>
    </div>
  );
}
