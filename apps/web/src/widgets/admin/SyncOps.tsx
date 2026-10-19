import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { Link } from '@tanstack/react-router';
import { DlqPanel } from './DlqPanel.js';
import { ErrorDetails } from './ErrorDetails.js';
import { relativeTime } from '../../lib/time.js';
import { queryKeyFor, useApiMutation, useApiQuery } from '../../api/useApiQuery.js';
import { errorToast, useUiStore } from '../../components/store/uiStore.js';
import {
  formatLag,
  notEnabledText,
  phaseLabel,
  phaseSeverity,
  type ConnectionList,
  type OrgSyncStatus,
  type RepoSyncStatus,
} from './contracts.js';

// Admin → Sync (UX_SPEC §4.i, FR-INGEST-8). The warehouse-backed fallback the
// SSE stream degrades to: if the stream is down this page still tells the
// operator what is happening, which is the whole point of having both.

/**
 * Poll while something is still moving (W20-04, UX_TODO INS-11).
 *
 * This is the page onboarding sends people to ("watch the first sync land"),
 * and it never changed: no poll, no focus refetch, and SSE never touched this
 * key. A repository that is `live` has landed; `error` and `paused` wait for a
 * human, so polling them changes nothing. Everything else — queued, history,
 * enrichment, and a budget pause that resumes on its own — is in motion.
 */
export const SYNC_POLL_MS = 5000;
const SETTLED_PHASES = new Set(['live', 'error', 'paused']);

export function syncPollInterval(status: OrgSyncStatus | undefined): number | false {
  return status?.repos.some((r) => !SETTLED_PHASES.has(r.phase)) ? SYNC_POLL_MS : false;
}

const STATUS = { endpoint: '/sync/status' } as const;

/**
 * Pause / Resume one repository (W20-07, UX_TODO INS-09).
 *
 * USER_STORIES E1.2/E1.6 and UX_SPEC §4.i promise both, and there was no way
 * to stop tracking a repository at all. Pausing stops every forge call for it
 * and keeps its history; resuming re-plans the backfill from where it
 * stopped. One click each: both are undone by the other.
 */
export function TrackingButton({ row }: { row: RepoSyncStatus }) {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const paused = row.phase === 'paused';
  const toggle = useApiMutation<{ paused: boolean }, { repo_id: number; sync_status: string }>(
    { endpoint: '/repos/{id}/tracking', path: { id: row.repoId }, method: 'PUT' },
    { invalidate: [queryKeyFor(STATUS)] },
  );
  const name = row.repoName ?? row.repoId;
  return (
    <button
      type="button"
      disabled={toggle.isPending}
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
      data-testid={`sync-tracking-${row.repoId}`}
      title={
        paused
          ? 'Start syncing again from where it stopped'
          : 'Stop all syncing for this repository; its history stays'
      }
      onClick={() =>
        toggle.mutate(
          { paused: !paused },
          {
            onError: (err: Error) => pushToasts([errorToast(`tracking-${row.repoId}-err`, err)]),
            onSuccess: () =>
              pushToasts([
                {
                  id: `tracking-${row.repoId}-ok`,
                  tone: 'ok',
                  message: paused
                    ? `${name} resumed — the backfill picks up where it stopped`
                    : `${name} paused — nothing syncs until you resume it`,
                },
              ]),
          },
        )
      }
    >
      {paused ? 'Resume' : 'Pause'}
    </button>
  );
}

/**
 * Retry an errored repository now (W20-14, UX_TODO INS-30): a fresh plan from
 * its cursors, the same thing the nightly sweep does for it at 03:17.
 */
export function RetryButton({ row }: { row: RepoSyncStatus }) {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const retry = useApiMutation<{ paused: boolean }, { repo_id: number; sync_status: string }>(
    { endpoint: '/repos/{id}/tracking', path: { id: row.repoId }, method: 'PUT' },
    { invalidate: [queryKeyFor(STATUS)] },
  );
  const name = row.repoName ?? row.repoId;
  return (
    <button
      type="button"
      disabled={retry.isPending}
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-testid={`sync-retry-${row.repoId}`}
      title="Plan this repository's sync again now, from where it stopped"
      onClick={() =>
        retry.mutate(
          { paused: false },
          {
            onError: (err: Error) => pushToasts([errorToast(`retry-${row.repoId}-err`, err)]),
            onSuccess: () =>
              pushToasts([
                {
                  id: `retry-${row.repoId}-ok`,
                  tone: 'ok',
                  message: `${name} queued to sync again`,
                },
              ]),
          },
        )
      }
    >
      {retry.isPending ? 'Retrying…' : 'Retry'}
    </button>
  );
}

/**
 * The empty state names which step is missing (W20-14, UX_TODO INS-31): it
 * said "connect an organisation first" even with a connection in place.
 */
export function syncEmptyMessage(connectionCount: number | undefined): string {
  if (connectionCount === undefined || connectionCount === 0) {
    return 'No forge is connected yet, so nothing is syncing.';
  }
  return 'A forge is connected, but no repositories are selected yet.';
}

export function SyncOps() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSyncStatus>(STATUS, {
    refetchInterval: syncPollInterval,
  });

  const repos = data?.repos ?? [];
  const { data: connections } = useApiQuery<ConnectionList>({ endpoint: '/connections' });
  const connectionCount = connections?.items?.filter((c) => c.status !== 'removed').length;
  // INS-32: the status endpoint has no real budget reading yet (every row is
  // 0/0), so the column is shown only once one is recorded.
  const budgetRecorded = repos.some((r) => r.budget.limit > 0);

  const budgetColumn: DataTableColumn<RepoSyncStatus> = {
    id: 'budget',
    header: 'Budget left',
    align: 'right',
    // Rate-limit budget is law (Law 7); an operator needs to see it before a
    // repo goes paused_budget, not after. A ZERO LIMIT IS NOT A BUDGET
    // (W16-57): 0/0 reads as exhausted, so such a row says so in words.
    cell: (row) =>
      row.budget.limit === 0 ? (
        <span className="text-xs text-fg-muted">not recorded</span>
      ) : (
        <span className="tabular-nums">
          {row.budget.remaining}/{row.budget.limit}
        </span>
      ),
  };

  const columns: DataTableColumn<RepoSyncStatus>[] = [
    // W16-05 (F11): this showed the numeric id. Falls back to it only if an
    // older API is answering, rather than rendering `undefined`.
    { id: 'repo', header: 'Repo', cell: (row) => row.repoName ?? row.repoId },
    {
      id: 'phase',
      header: 'Phase',
      cell: (row) => (
        <SeverityBadge severity={phaseSeverity(row.phase)} label={phaseLabel(row.phase)} />
      ),
    },
    {
      id: 'pct',
      // NOT "Progress" (W16-57). percentComplete is how far back the ingested
      // history reaches as a fraction of the 365-day backfill target — so a
      // repository that is fully caught up and phase `live` still reads 9% on a
      // fixture holding 40 days. Under a column called Progress that says the
      // sync is stuck, next to a phase saying it is finished.
      header: 'History loaded (of 1 year)',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{Math.round(row.percentComplete)}%</span>,
    },
    ...(budgetRecorded ? [budgetColumn] : []),
    {
      // UX_SPEC §4.i (INS-32): when the forge last told us about a change.
      // "never" is normal for a repo tracked minutes ago, or one whose forge
      // cannot reach this install (it then updates with the nightly sync).
      id: 'webhook',
      header: 'Last webhook',
      cell: (row) => (
        <span className="text-xs text-fg-muted" data-testid={`sync-webhook-${row.repoId}`}>
          {row.lastWebhookAt === undefined ? '—' : relativeTime(row.lastWebhookAt)}
        </span>
      ),
    },
    {
      id: 'lag',
      header: 'Lag',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{formatLag(row.lagSeconds)}</span>,
    },
    {
      // W17-39: a feature the owner switched off (issues disabled on a Gitea
      // repo answers 404) is information about the repository, not a sync
      // failure — muted text, its own column, never the red one beside it.
      id: 'features',
      header: 'Repo settings',
      cell: (row) => {
        const text = notEnabledText(row.entities ?? {});
        return text ? (
          <span className="text-xs text-fg-muted" data-testid={`sync-not-enabled-${row.repoId}`}>
            {text}
          </span>
        ) : (
          ''
        );
      },
    },
    {
      id: 'error',
      header: 'Last error',
      // ADM-16: the whole line, expandable, not a 60-character cut with the
      // rest in a mouse-only tooltip.
      cell: (row) =>
        row.lastError ? (
          <ErrorDetails
            message={row.lastError.message}
            at={row.lastError.at}
            testId={`sync-error-${row.repoId}`}
          />
        ) : (
          '—'
        ),
    },
    {
      id: 'tracking',
      header: 'Tracking',
      cell: (row) => (
        <div className="flex gap-1.5">
          {row.phase === 'error' && <RetryButton row={row} />}
          <TrackingButton row={row} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="admin-sync">
      <WidgetFrame
        title="Org sync"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
      >
        {data && (
          <dl className="flex flex-wrap gap-6 text-sm" data-testid="sync-summary">
            <div>
              <dt className="text-xs text-fg-muted">Phase</dt>
              <dd data-testid="sync-phase">{phaseLabel(data.phase)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Repos</dt>
              <dd className="tabular-nums">{data.repoCount}</dd>
            </div>
            <div>
              {/* Same measure, same honesty as the column below (W16-57). */}
              <dt className="text-xs text-fg-muted">History loaded (of 1 year)</dt>
              <dd className="tabular-nums">{Math.round(data.percentComplete)}%</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Worst lag</dt>
              <dd className="tabular-nums">{formatLag(data.worstLagSeconds)}</dd>
            </div>
          </dl>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="Per-repo sync"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && repos.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage={syncEmptyMessage(connectionCount)}
        emptyAction={
          <Link
            to="/admin/"
            className="text-xs text-accent underline-offset-2 hover:underline"
            data-testid="sync-empty-action"
          >
            {connectionCount ? 'Choose repositories in Connections →' : 'Connect a forge →'}
          </Link>
        }
      >
        <div data-testid="sync-repo-table">
          <DataTable
            name="admin-sync"
            columns={columns}
            data={repos}
            getRowId={(row) => row.repoId}
          />
        </div>
      </WidgetFrame>

      {/* W4-20: the endpoint exists now, so this is the real control. */}
      <DlqPanel />
    </div>
  );
}
