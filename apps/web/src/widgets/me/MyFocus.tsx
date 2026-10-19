import { Link } from '@tanstack/react-router';
import {
  DataTable,
  KpiTile,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery.js';
import { useAuthProviders } from '../auth/contracts.js';
import { spansMultipleRepos, type MeContext, type RepoRef } from '../org/contracts.js';
import {
  REVIEW_SLA_DAYS,
  formatAge,
  isOverSla,
  prStage,
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

/**
 * The way out of the identity-unlinked state (W20-12, UX_TODO DSH-42): the copy
 * said "Re-authorize GitHub" with nothing to press. Offered only when GitHub
 * sign-in is configured — a button to a provider this install does not have
 * would be a dead end.
 */
function ReauthorizeLink() {
  const { providers } = useAuthProviders();
  if (!providers.github) return null;
  return (
    <a
      href="/auth/login"
      className="inline-flex h-8 items-center rounded-md border border-border bg-surface-2 px-3 text-sm font-medium text-fg hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-testid="reauthorize-github"
    >
      Sign in with GitHub again
    </a>
  );
}

export function MyFocus({ search }: Props) {
  const now = Date.now();
  // W20-12 (UX_TODO DSH-42): the list defaults to OPEN pull requests; merged
  // and closed ones are history and sit behind this toggle.
  const [showClosed, setShowClosed] = useState(false);
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
    /** W20-12 (DSH-87): reviews I submitted. Older API: only review_requests. */
    reviews_given?: number;
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
      <div className="flex flex-col gap-3" data-testid="identity-unlinked">
        <WidgetFrame
          title="My Focus"
          state="empty"
          emptyMessage="We could not match your login to a commit author in this workspace, so your PRs and review load cannot be shown. Sign in with GitHub again to link it, or ask an admin to check the identity mapping."
        />
        <div>
          <ReauthorizeLink />
        </div>
      </div>
    );
  }

  // Each list is fetched separately, so each decides its own Repository column
  // from its OWN rows: a developer whose PRs are all in one repo but whose
  // review queue spans four should see the column on exactly one of them.
  const prItems = prs.data?.items ?? [];
  // OPEN means open (W16-51). The "Open PRs" tile counted the whole list, which
  // /me/prs returns in EVERY state — so the tile read 2 above a table showing
  // one open PR and one merged one, on a screen whose job is telling someone
  // what is on their plate. A merged pull request is not on anyone's plate.
  const openPrItems = prItems.filter((pr) => pr.state === 'open');
  const closedCount = prItems.length - openPrItems.length;
  const shownPrItems = showClosed ? prItems : openPrItems;
  const reviewsGiven = since.data ? (since.data.reviews_given ?? since.data.review_requests) : 0;
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
    ...(spansMultipleRepos(shownPrItems) ? [repoColumn<MyPr>()] : []),
    {
      // W20-12 (UX_TODO DSH-42): what each PR is waiting on, and for how
      // long — the stage chip the spec draws — instead of the bare state.
      id: 'stage',
      header: 'Stage',
      cell: (row) => {
        const stage = prStage(row);
        if (!stage) return <span className="text-fg-muted">{row.state}</span>;
        return (
          <span className="whitespace-nowrap" data-testid="pr-stage-chip">
            <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs">{stage.label}</span>{' '}
            <span className="text-xs tabular-nums text-fg-muted">
              {formatAge(stage.since, now)}
            </span>
          </span>
        );
      },
    },
    { id: 'size', header: 'Size', cell: (row) => row.size_bucket },
    {
      id: 'age',
      header: 'Open for',
      align: 'right',
      cell: (row) => {
        // An open PR that has sat past the SLA is the actionable one, so it is
        // marked. Merged AND closed PRs are history and never highlighted —
        // a closed, unmerged PR was flagged as stalled forever (W20-12, DSH-41).
        const open = row.state === 'open';
        const stalled = open && isOverSla(row.opened_at, now);
        return (
          <span className={`tabular-nums ${stalled ? 'text-warn' : ''}`}>
            {open ? formatAge(row.opened_at, now) : '—'}
          </span>
        );
      },
    },
  ];

  const queueColumns: DataTableColumn<ReviewQueueItem>[] = [
    {
      id: 'pr',
      // W20-09 (UX_TODO DSH-85): requested reviewers are not ingested, so
      // this cannot be "awaiting MY review". It is what the API can know:
      // open, non-draft, non-bot PRs by others that I have not reviewed.
      header: 'Open PRs by others',
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
      // W20-12 (UX_TODO DSH-41, partial): the age is measured from when the
      // PR was OPENED — review-request times are not ingested — so the header
      // says that instead of "Waiting", which implied the request's age.
      header: 'Open for',
      align: 'right',
      cell: (row) => {
        const over = isOverSla(row.opened_at, now);
        return (
          <span
            className={`flex items-center justify-end gap-1.5 tabular-nums ${over ? 'text-warn' : ''}`}
            {...(over ? { 'data-testid': 'over-sla' } : {})}
          >
            {over && <SeverityBadge severity="medium" label="overdue" />}
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
      header: 'My lines (90d)',
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
        (reviewsGiven > 0 || since.data.prs_advanced > 0 || since.data.findings_on_my_prs > 0) && (
          // W20-12 (UX_TODO DSH-87): the first count is reviews the user GAVE —
          // it was labelled "review requests", telling someone who reviewed
          // five PRs that five people were waiting on them. DSH-42: the PR and
          // findings counts jump to the list they are about (each PR's page
          // carries its automated-review findings).
          <div className="panel-inset px-3 py-2 text-xs" data-testid="since-strip">
            Since your last visit: you gave {reviewsGiven}{' '}
            {reviewsGiven === 1 ? 'review' : 'reviews'},{' '}
            <a href="#my-prs" className="text-accent underline-offset-2 hover:underline">
              {since.data.prs_advanced} of your pull requests advanced
            </a>
            ,{' '}
            <a href="#my-prs" className="text-accent underline-offset-2 hover:underline">
              {since.data.findings_on_my_prs} new findings on your pull requests
            </a>
            .
          </div>
        )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="my-stats">
        {/* W20-12 (UX_TODO DSH-40): "—" until the data is in — `?? 0` showed
            a confident 0 while loading or after a failure — and the labels
            say which period the counts cover. */}
        <KpiTile
          label="PRs merged (all time)"
          value={stats.data ? String(stats.data.merged_prs) : null}
          polarity="neutral"
        />
        <KpiTile
          label="Median merged PR size (all time)"
          // `?? null` inside String() rendered the literal text "null" while
          // the request was still in flight — and a non-null string also slips
          // past KpiTile's value === null guard, so the tile captioned itself
          // "not compared" rather than "not measured". Found by an agent
          // reading the tile's own null handling.
          value={
            typeof stats.data?.median_size === 'number' ? String(stats.data.median_size) : null
          }
          unit="lines"
          polarity="neutral"
        />
        <KpiTile
          label="Open PRs (now)"
          value={prs.data ? String(openPrItems.length) : null}
          polarity="neutral"
        />
        <KpiTile
          label="Open PRs by others (now)"
          value={queue.data ? String(queueItems.length) : null}
          polarity="neutral"
        />
      </div>

      <WidgetFrame
        title="My pull requests"
        state={frameState({
          isLoading: prs.isLoading,
          isError: prs.isError,
          isEmpty: prs.data !== undefined && prItems.length === 0,
        })}
        // W20-12 (UX_TODO DSH-43): the error object too, so the frame shows
        // the request id like every other screen.
        {...(prs.error ? { errorMessage: prs.error.message, error: prs.error } : {})}
        onRetry={() => void prs.refetch()}
        emptyMessage="No pull requests authored by you in this workspace."
        drillDown={
          closedCount > 0 ? (
            <button
              type="button"
              className="text-xs text-accent underline-offset-2 hover:underline"
              onClick={() => setShowClosed((v) => !v)}
              aria-pressed={showClosed}
              data-testid="my-prs-toggle-closed"
            >
              {showClosed ? 'Open only' : `Show merged and closed (${closedCount})`}
            </button>
          ) : undefined
        }
      >
        <div data-testid="my-prs" id="my-prs">
          {shownPrItems.length === 0 ? (
            // Not the frame's empty state: the author HAS pull requests, just
            // none open, and the toggle above shows them.
            <p className="text-sm text-fg-muted" data-testid="my-prs-none-open">
              Nothing open — {closedCount} merged or closed{' '}
              {closedCount === 1 ? 'pull request is' : 'pull requests are'} hidden.
            </p>
          ) : (
            <DataTable
              name="my-prs"
              columns={prColumns}
              data={shownPrItems}
              getRowId={(row) => `${row.repo_id}:${row.number}`}
            />
          )}
        </div>
      </WidgetFrame>

      <WidgetFrame
        title={`Open PRs by others you haven't reviewed (over ${REVIEW_SLA_DAYS}d flagged)`}
        state={frameState({
          isLoading: queue.isLoading,
          isError: queue.isError,
          isEmpty: queue.data !== undefined && queueItems.length === 0,
        })}
        {...(queue.error ? { errorMessage: queue.error.message, error: queue.error } : {})}
        onRetry={() => void queue.refetch()}
        emptyMessage="No open pull requests by others are waiting without a review from you."
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
        // W20-12 (UX_TODO DSH-88): it was "Hotspots I own" over an all-time sum
        // with no hotspot score — the honest name for what the list is.
        title="Files I've changed most (last 90 days)"
        state={frameState({
          isLoading: hotspots.isLoading,
          isError: hotspots.isError,
          isEmpty: hotspots.data !== undefined && hotspotItems.length === 0,
        })}
        {...(hotspots.error ? { errorMessage: hotspots.error.message, error: hotspots.error } : {})}
        onRetry={() => void hotspots.refetch()}
        emptyMessage="You have not changed any files in the last 90 days."
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
