import { Link } from '@tanstack/react-router';
import {
  DataTable,
  KpiTile,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { spansMultipleRepos, type MeContext, type RepoRef } from '../org/contracts.js';
import {
  REVIEW_SLA_DAYS,
  formatAge,
  isOverSla,
  type MyHotspot,
  type MyHotspots,
  type MyPr,
  type MyPrs,
  type MyStats,
  type ReviewQueue,
  type ReviewQueueItem,
} from './contracts.js';

// My Focus (UX_SPEC §4.f, FR-WEB-7). Everything here is the caller's OWN data:
// N-9 forbids cross-person comparison, so there are no leaderboards and no
// "you vs the team" framing anywhere on this screen.

interface Props {
  search: Record<string, string>;
}

export function MyFocus({ search }: Props) {
  const now = Date.now();
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  const prs = useApiQuery<MyPrs>({ endpoint: '/me/prs' });
  const queue = useApiQuery<ReviewQueue>({ endpoint: '/me/review-queue' });
  const hotspots = useApiQuery<MyHotspots>({ endpoint: '/me/hotspots' });
  const stats = useApiQuery<MyStats>({ endpoint: '/me/stats' });
  // Since-last-visit (W6-09, R-A5). Its own query so a slow count never delays
  // the queue below it — the queue is what people came for.
  const since = useApiQuery<{
    since: string | null;
    first_visit: boolean;
    review_requests: number;
    prs_advanced: number;
    findings_on_my_prs: number;
  }>({ endpoint: '/me/since' });

  // Identity-unlinked is a DISTINCT state from "nothing to do" (UX_SPEC §4.f).
  // Both render empty lists, but only one is fixable by the user, and telling
  // someone they have no work when we simply cannot find them is the worse
  // failure of the two.
  if (me && me.identity_id === null) {
    return (
      <WidgetFrame
        title="My Focus"
        state="empty"
        emptyMessage="We could not match your login to a commit author in this workspace, so your PRs and review load cannot be shown. Re-authorize GitHub, or ask an admin to check the identity mapping."
        data-testid="identity-unlinked"
      />
    );
  }

  // Each list is fetched separately, so each decides its own Repository column
  // from its OWN rows: a developer whose PRs are all in one repo but whose
  // review queue spans four should see the column on exactly one of them.
  const prItems = prs.data?.items ?? [];
  const queueItems = queue.data?.items ?? [];
  const hotspotItems = hotspots.data?.items ?? [];

  // PR numbers and file paths both repeat across repositories — "#5 feature 5"
  // twice is two pull requests, not a duplicated row — so the repository is
  // part of a row's identity on every cross-repo list here.
  function repoColumn<T extends { repo: RepoRef }>(): DataTableColumn<T> {
    return {
      id: 'repo',
      header: 'Repository',
      cell: (row) => (
        <span className="text-xs whitespace-nowrap text-fg-muted">
          {row.repo.org}/{row.repo.name}
        </span>
      ),
    };
  }

  const prColumns: DataTableColumn<MyPr>[] = [
    {
      id: 'pr',
      header: 'Pull request',
      cell: (row) => (
        <Link
          to="/repos/$repoId/prs/$number"
          params={{ repoId: String(row.repo_id), number: String(row.number) }}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          #{row.number} {row.title}
        </Link>
      ),
    },
    ...(spansMultipleRepos(prItems) ? [repoColumn<MyPr>()] : []),
    { id: 'state', header: 'State', cell: (row) => row.state },
    { id: 'size', header: 'Size', cell: (row) => row.size_bucket },
    {
      id: 'age',
      header: 'Open for',
      align: 'right',
      cell: (row) => {
        // An open PR that has sat past the SLA is the actionable one, so it is
        // marked. A merged PR is history and never highlighted.
        const stalled = row.merged_at === null && isOverSla(row.opened_at, now);
        return (
          <span className={`tabular-nums ${stalled ? 'text-warn' : ''}`}>
            {row.merged_at === null ? formatAge(row.opened_at, now) : '—'}
          </span>
        );
      },
    },
  ];

  const queueColumns: DataTableColumn<ReviewQueueItem>[] = [
    {
      id: 'pr',
      header: 'Awaiting my review',
      cell: (row) => (
        <Link
          to="/repos/$repoId/prs/$number"
          params={{ repoId: String(row.repo_id), number: String(row.number) }}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          #{row.number} {row.title}
        </Link>
      ),
    },
    ...(spansMultipleRepos(queueItems) ? [repoColumn<ReviewQueueItem>()] : []),
    { id: 'author', header: 'Author', cell: (row) => row.author },
    {
      id: 'age',
      header: 'Waiting',
      align: 'right',
      cell: (row) => {
        const over = isOverSla(row.opened_at, now);
        return (
          <span
            className={`flex items-center justify-end gap-1.5 tabular-nums ${over ? 'text-warn' : ''}`}
            {...(over ? { 'data-testid': 'over-sla' } : {})}
          >
            {over && <SeverityBadge severity="medium" />}
            {formatAge(row.opened_at, now)}
          </span>
        );
      },
    },
  ];

  const hotspotColumns: DataTableColumn<MyHotspot>[] = [
    {
      id: 'path',
      header: 'File',
      cell: (row) => (
        <Link
          to="/repos/$repoId/files/$"
          params={{ repoId: String(row.repo_id), _splat: row.path } as never}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {row.path}
        </Link>
      ),
    },
    ...(spansMultipleRepos(hotspotItems) ? [repoColumn<MyHotspot>()] : []),
    {
      id: 'lines',
      header: 'My lines',
      align: 'right',
      sortable: true,
      cell: (row) => <span className="tabular-nums">{row.my_lines}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="my-focus">
      {/* Since-last-visit strip. Rendered only when there IS a previous visit
          and something changed: a strip that says "0 new" every load is
          furniture people learn to skip. */}
      {since.data &&
        !since.data.first_visit &&
        (since.data.review_requests > 0 ||
          since.data.prs_advanced > 0 ||
          since.data.findings_on_my_prs > 0) && (
          <div
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs"
            data-testid="since-strip"
          >
            Since your last visit: {since.data.review_requests} review
            {since.data.review_requests === 1 ? ' request' : ' requests'}, {since.data.prs_advanced}{' '}
            of your pull requests advanced, {since.data.findings_on_my_prs} new findings on your
            work.
          </div>
        )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="my-stats">
        <KpiTile
          label="PRs merged"
          value={String(stats.data?.merged_prs ?? 0)}
          polarity="neutral"
        />
        <KpiTile
          label="Median PR size"
          value={stats.data?.median_size === null ? null : String(stats.data?.median_size ?? null)}
          unit="lines"
          polarity="neutral"
        />
        <KpiTile label="Open PRs" value={String(prItems.length)} polarity="neutral" />
        <KpiTile label="To review" value={String(queueItems.length)} polarity="neutral" />
      </div>

      <WidgetFrame
        title="My pull requests"
        state={frameState({
          isLoading: prs.isLoading,
          isError: prs.isError,
          isEmpty: prs.data !== undefined && prItems.length === 0,
        })}
        {...(prs.error ? { errorMessage: prs.error.message } : {})}
        onRetry={() => void prs.refetch()}
        emptyMessage="Nothing open — you have no pull requests in flight."
      >
        <div data-testid="my-prs">
          <DataTable
            name="my-prs"
            columns={prColumns}
            data={prItems}
            getRowId={(row) => `${row.repo_id}:${row.number}`}
          />
        </div>
      </WidgetFrame>

      <WidgetFrame
        title={`Review queue (over ${REVIEW_SLA_DAYS}d flagged)`}
        state={frameState({
          isLoading: queue.isLoading,
          isError: queue.isError,
          isEmpty: queue.data !== undefined && queueItems.length === 0,
        })}
        {...(queue.error ? { errorMessage: queue.error.message } : {})}
        onRetry={() => void queue.refetch()}
        emptyMessage="Your review queue is clear."
      >
        <div data-testid="review-queue">
          <DataTable
            name="review-queue"
            columns={queueColumns}
            data={queueItems}
            getRowId={(row) => `${row.repo_id}:${row.number}`}
          />
        </div>
      </WidgetFrame>

      <WidgetFrame
        title="Hotspots I own"
        state={frameState({
          isLoading: hotspots.isLoading,
          isError: hotspots.isError,
          isEmpty: hotspots.data !== undefined && hotspotItems.length === 0,
        })}
        {...(hotspots.error ? { errorMessage: hotspots.error.message } : {})}
        onRetry={() => void hotspots.refetch()}
        emptyMessage="No files with your authorship are currently hot."
      >
        <div data-testid="my-hotspots">
          <DataTable
            name="my-hotspots"
            columns={hotspotColumns}
            data={hotspotItems}
            getRowId={(row) => `${row.repo_id}:${row.path}`}
          />
        </div>
      </WidgetFrame>
    </div>
  );
}
