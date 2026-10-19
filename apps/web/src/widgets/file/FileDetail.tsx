import {
  Chart,
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { Link, useSearch } from '@tanstack/react-router';
import { serializeGlobalSearch, type GlobalSearch } from '@repopulse/shared/url-state';
import { docsUrl } from '../../lib/docs.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { IntentControl } from './IntentControl.js';
import { VERIFY_LABEL, locationOf, type Finding } from '../findings/contracts.js';
import {
  SINGLE_OWNER_THRESHOLD,
  STALE_FILE_DAYS,
  busFactorOf,
  forgeNameOf,
  type FileDetail as FileDetailResponse,
} from './contracts.js';
import { FindingSeverityBadge } from '../findings/FindingSeverity.js';

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

  // This file's own findings (W16-46). The panel below was a hardcoded teaser —
  // "File-scoped findings arrive with Tier-2 analysis (wave W6)" — years after
  // W6 shipped, on the one screen where a finding's file:line is the entire
  // subject. Every finding already carries `file`; only the filter was missing.
  const {
    data: findings,
    isLoading: findingsLoading,
    isError: findingsIsError,
    error: findingsError,
    refetch: refetchFindings,
  } = useApiQuery<{ items: Finding[] }>({
    endpoint: '/findings',
    query: { repo_id: repoId, file: path },
  });
  const findingItems = findings?.items ?? [];
  // W20-12 (UX_TODO DSH-35): the PR links below carried no search, so leaving
  // for a PR dropped the window and repository filters the reader had set.
  const preserved = serializeGlobalSearch(useSearch({ strict: false }) as GlobalSearch);
  // W20-12 (UX_TODO DSH-94): no default-branch commit yet — a file new in an
  // open PR. Churn, owners and hotspot history have nothing to show and the
  // intent control has nothing to steer; findings and PRs still apply.
  const noCommits = data?.no_commits === true;
  const busFactor = busFactorOf(data?.owners ?? []);

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
      {/* UX_SPEC §4.d's deleted/renamed banner. It reports what the warehouse
          knows — the last date we saw a touch, and the paths this file was
          known by — and does NOT claim the file was deleted, because ingestion
          cannot distinguish a deletion from a quiet file. */}
      {(staleFile || (data?.previous_paths.length ?? 0) > 0) && (
        <div
          className="panel-inset px-3 py-2 text-xs text-fg-muted"
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
        {/* W20-12 (UX_TODO DSH-69): wraps instead of `truncate`, which cut
            the RIGHT end of a long path — the file name — on a phone. The
            title carries the full path for a pointer user as well. */}
        <h1
          className="min-w-0 break-all font-mono text-lg font-semibold"
          title={data?.path ?? path}
          data-testid="file-path"
        >
          {data?.path ?? path}
        </h1>
        {/* W20-12 (UX_TODO DSH-35): the current score in the header, so the
            reader arriving from a hotspot list sees the number they clicked. */}
        {data && !noCommits && (
          <span className="text-xs text-fg-muted tabular-nums" data-testid="file-hotspot-now">
            {data.hotspot
              ? `hotspot ${data.hotspot.score.toFixed(2)} (last ${data.hotspot.window_days}d)`
              : 'not touched in the last 30d, so not a hotspot'}
            {busFactor !== null && ` · bus factor ${busFactor}`}
          </span>
        )}
        {/* W20-12 (UX_TODO DSH-68): RepoPulse stores no source (C1), so the
            code itself is one click away on the forge, not a search away. */}
        {data?.forge_url && (
          <a
            href={data.forge_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-accent underline-offset-2 hover:underline"
            data-testid="file-forge-link"
          >
            View on {forgeNameOf(data.forge_url)}
            {data.default_branch ? ` (${data.default_branch})` : ''} ↗
          </a>
        )}
        {singleOwner && (
          <span className="flex items-center gap-1.5" data-testid="single-owner-flag">
            <SeverityBadge severity="medium" label="bus factor 1" />
            <span className="text-xs text-fg-muted">
              single owner — {Math.round(topShare * 100)}% of changed lines
            </span>
          </span>
        )}
      </header>

      {/* W6-09: the intent control sits at the top, because deciding what a
          team means to do about a file is context for every number below it.
          Under the file's name, not above it (W18-28): above, it was the first
          thing on the page and read as belonging to the repository header. */}
      {noCommits ? (
        <p
          className="panel-inset px-3 py-2 text-sm text-fg-muted"
          role="note"
          data-testid="file-no-commits"
        >
          This file has no commits on the default branch yet — it is new in an open pull request, or
          older than the history RepoPulse has backfilled. Churn, owners and hotspot history appear
          once a commit touching it lands on the default branch.
        </p>
      ) : (
        <IntentControl repoId={Number(repoId)} path={path} />
      )}

      {!noCommits && (
        <WidgetFrame
          title="Churn, last 52 weeks"
          state={frameState({
            isLoading,
            isError,
            isEmpty: data !== undefined && data.churn_series.length === 0,
          })}
          {...(error ? { errorMessage: error.message, error } : {})}
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
              grid: { left: 48, right: 12, top: 30, bottom: 32 },
              legend: { data: ['Gross', 'Net', 'Rework'] },
              xAxis: { type: 'category', data: weeks.map((w) => w.week) },
              // W20-12 (UX_TODO DSH-35): the axis names its unit, as TrendChart's do.
              yAxis: { type: 'value', name: 'lines', nameLocation: 'end' as const, nameGap: 8 },
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
      )}

      {!noCommits && (
        <WidgetFrame
          title="Owners"
          state={frameState({
            isLoading,
            isError,
            isEmpty: data !== undefined && data.owners.length === 0,
          })}
          {...(error ? { errorMessage: error.message, error } : {})}
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
      )}

      <WidgetFrame
        title="Findings"
        state={frameState({
          isLoading: findingsLoading,
          isError: findingsIsError,
          isEmpty: findings !== undefined && findingItems.length === 0,
        })}
        {...(findingsError ? { errorMessage: findingsError.message, error: findingsError } : {})}
        onRetry={() => void refetchFindings()}
        emptyMessage="No findings recorded against this file."
      >
        {/* W18-28: scrolls inside its own region at phone width instead of
            squeezing every column until the headers run together. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="File findings">
          <table className="table-plain w-full min-w-[36rem] text-sm" data-testid="file-findings">
            <caption className="sr-only">Findings recorded against this file</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Lines</th>
                <th scope="col">Status</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody>
              {findingItems.map((f) => (
                <tr key={f.id} className="border-t border-border">
                  {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                  <td className="py-1 whitespace-nowrap">
                    <FindingSeverityBadge severity={f.severity} />
                  </td>
                  <th scope="row" className="py-1 text-left font-normal">
                    {/* Links into the repo's Findings tab, which owns triage —
                        this panel reports, it does not duplicate the actions. */}
                    <Link
                      to="/repos/$repoId/findings"
                      params={{ repoId }}
                      search={(prev: Record<string, unknown>) => ({ ...prev, finding: f.id })}
                      className="text-accent hover:underline"
                    >
                      {f.title}
                    </Link>
                  </th>
                  {/* The file is the page, so only the lines are news here. */}
                  <td className="py-1 font-mono text-xs">
                    {locationOf(f).replace(`${f.file}:`, '')}
                  </td>
                  <td className="py-1 text-xs">{f.status.replace('_', ' ')}</td>
                  <td className="py-1 text-xs whitespace-nowrap">
                    {VERIFY_LABEL[f.verify_status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>

      {!noCommits && (
        <WidgetFrame
          title="Hotspot score history"
          state={frameState({
            isLoading,
            isError,
            isEmpty: data !== undefined && data.hotspot_history.length < 2,
          })}
          onRetry={() => void refetch()}
          definitionHref={docsUrl('/docs/design/METRICS.md')}
          // A single point is not a history. The empty state that stood here said
          // a flat line drawn from one current value would invent a trend — so
          // fewer than two points stays empty rather than becoming that line.
          emptyMessage="Needs at least two snapshots — the history builds up as nightly runs accumulate."
        >
          <Chart
            testId="file-hotspot-history"
            ariaLabel={`Hotspot score history for ${path}`}
            height={160}
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
              // W18-28: at 120px with ECharts' default ticks the six labels
              // (0.1 … 0.6) overprinted each other. The score is a 0–1 fraction,
              // so a fixed 0 / 0.5 / 1 scale is both legible and comparable
              // between files, which an auto-fitted axis was not.
              yAxis: { type: 'value', min: 0, max: 1, splitNumber: 2 },
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
      )}

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
                search={preserved as never}
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
