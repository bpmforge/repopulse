import { useState } from 'react';
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
 * Problem phases first (W20-15, UX_TODO X-18). At 500 repositories, finding the
 * three in `error` meant reading every row in database order.
 */
const PHASE_ORDER: Record<string, number> = {
  error: 0,
  paused_budget: 1,
  paused: 2,
  queued: 3,
  history: 4,
  enrichment: 5,
  live: 6,
};

export function sortProblemsFirst(repos: readonly RepoSyncStatus[]): RepoSyncStatus[] {
  return [...repos].sort(
    (a, b) =>
      (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9) ||
      (a.repoName ?? a.repoId).localeCompare(b.repoName ?? b.repoId),
  );
}

/** How many repositories are in each phase, problem phases first. */
export function phaseCounts(repos: readonly RepoSyncStatus[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.phase, (counts.get(r.phase) ?? 0) + 1);
  return [...counts].sort((a, b) => (PHASE_ORDER[a[0]] ?? 9) - (PHASE_ORDER[b[0]] ?? 9));
}

/** "github · github.com" — the connection a row syncs through. */
export function connectionLabel(c: RepoSyncStatus['connection']): string {
  // Absent: an older API that does not say. Null: the connection row is gone.
  if (c === undefined) return '';
  if (c === null) return 'connection removed';
  return c.host ? `${c.provider} · ${c.host}` : c.provider;
}

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

interface PurgeResult {
  repo: string;
  deleted: Record<string, number>;
  ci_tokens_revoked: number;
  webhooks_removed: number;
  webhook_failures: { repo: string; error: string }[];
}

/** What a purge did, in one sentence for the toast (W20-19, INS-09). */
export function purgedMessage(res: PurgeResult): string {
  const rows = Object.entries(res.deleted)
    .filter(([table]) => table !== 'repos')
    .reduce((n, [, c]) => n + c, 0);
  const parts = [`${res.repo} removed and ${rows} stored record${rows === 1 ? '' : 's'} deleted`];
  if (res.ci_tokens_revoked > 0) {
    parts.push(
      `${res.ci_tokens_revoked} CI token${res.ci_tokens_revoked === 1 ? '' : 's'} for it alone revoked`,
    );
  }
  if (res.webhook_failures.length > 0) {
    parts.push(
      `its webhook could not be removed (${res.webhook_failures[0]!.error}); delete it in the forge`,
    );
  }
  return parts.join('; ') + '.';
}

/**
 * Remove a repository AND delete its stored history (W20-19, UX_TODO INS-09;
 * decision 2026-10-20). Admins only (this whole screen is), behind a typed
 * confirmation of the repository's org/name, and deliberately the second
 * choice: Pause, beside it, keeps every chart.
 */
export function PurgeButton({ row }: { row: RepoSyncStatus }) {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const purge = useApiMutation<{ confirm: string }, PurgeResult>(
    { endpoint: '/repos/{id}', path: { id: row.repoId }, method: 'DELETE' },
    { invalidate: [queryKeyFor(STATUS)] },
  );
  const name = row.repoName ?? row.repoId;
  if (!open) {
    return (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-crit"
        data-testid={`sync-purge-${row.repoId}`}
        title="Stop tracking it and delete everything stored about it"
        onClick={() => setOpen(true)}
      >
        Remove…
      </button>
    );
  }
  const matches = typed.trim() === name;
  const inputId = `sync-purge-input-${row.repoId}`;
  return (
    <div className="flex max-w-xs flex-col gap-1" data-testid={`sync-purge-confirm-${row.repoId}`}>
      <p className="text-xs text-fg-muted">
        Remove <span className="text-fg">{name}</span> and delete its history? Its pull requests,
        commits, findings, scans and metrics are deleted for good, and its webhook is removed. To
        stop syncing and keep the history, use Pause instead.
      </p>
      <label htmlFor={inputId} className="text-xs text-fg-muted">
        Type <span className="font-mono text-fg">{name}</span> to confirm
      </label>
      <input
        id={inputId}
        className="panel px-2 py-1 font-mono text-xs"
        autoComplete="off"
        // The one thing to answer (ADM-69's rule).
        autoFocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        data-testid={`sync-purge-input-${row.repoId}`}
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={!matches || purge.isPending}
          className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10 disabled:opacity-50"
          data-testid={`sync-purge-do-${row.repoId}`}
          onClick={() =>
            purge.mutate(
              { confirm: typed.trim() },
              {
                onError: (err: Error) => pushToasts([errorToast(`purge-${row.repoId}-err`, err)]),
                onSuccess: (res) =>
                  pushToasts([
                    {
                      id: `purge-${row.repoId}-ok`,
                      tone: res.webhook_failures.length > 0 ? 'warn' : 'ok',
                      message: purgedMessage(res),
                    },
                  ]),
              },
            )
          }
        >
          {purge.isPending ? 'Deleting…' : 'Delete history'}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
          onClick={() => {
            setOpen(false);
            setTyped('');
          }}
        >
          Cancel
        </button>
      </div>
    </div>
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
 * Sync a live repository now (W20-22, UX_TODO INS-30): one catch-up pass, the
 * same one the nightly sweep runs, for when a webhook was missed and a change
 * is not showing yet. Repeated clicks within ten minutes share one pass.
 */
export function SyncNowButton({ row }: { row: RepoSyncStatus }) {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const syncNow = useApiMutation<Record<string, never>, { repo_id: number; queued: boolean }>(
    { endpoint: '/repos/{id}/sync-now', path: { id: row.repoId }, method: 'POST' },
    { invalidate: [queryKeyFor(STATUS)] },
  );
  const name = row.repoName ?? row.repoId;
  return (
    <button
      type="button"
      disabled={syncNow.isPending}
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-testid={`sync-now-${row.repoId}`}
      title="Fetch what changed on the forge since the last sync, now rather than tonight"
      onClick={() =>
        syncNow.mutate(
          {},
          {
            onError: (err: Error) => pushToasts([errorToast(`sync-now-${row.repoId}-err`, err)]),
            onSuccess: () =>
              pushToasts([
                {
                  id: `sync-now-${row.repoId}-ok`,
                  tone: 'ok',
                  message: `${name} queued to catch up with the forge`,
                },
              ]),
          },
        )
      }
    >
      {syncNow.isPending ? 'Queuing…' : 'Sync now'}
    </button>
  );
}

/**
 * The empty state names which step is missing (W20-14, UX_TODO INS-31): it
 * said "connect an organization first" even with a connection in place.
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

  // A phase picked from the summary narrows the table ("3 errors").
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const allRepos = data?.repos ?? [];
  const repos = sortProblemsFirst(
    phaseFilter ? allRepos.filter((r) => r.phase === phaseFilter) : allRepos,
  );
  const counts = phaseCounts(allRepos);
  const { data: connections } = useApiQuery<ConnectionList>({ endpoint: '/connections' });
  const connectionCount = connections?.items?.filter((c) => c.status !== 'removed').length;
  // INS-32: the status endpoint has no real budget reading yet (every row is
  // 0/0), so the column is shown only once one is recorded.
  const budgetRecorded = allRepos.some((r) => r.budget.limit > 0);

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
      // W20-15 (UX_TODO X-18): which of several connections is the one failing.
      id: 'connection',
      header: 'Connection',
      cell: (row) => <span className="text-xs">{connectionLabel(row.connection)}</span>,
    },
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
        <div className="flex flex-wrap gap-1.5">
          {row.phase === 'error' && <RetryButton row={row} />}
          {row.phase === 'live' && <SyncNowButton row={row} />}
          <TrackingButton row={row} />
          <PurgeButton row={row} />
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
        {counts.length > 0 && (
          // Counts per phase that filter the table below (W20-15, X-18).
          <div
            className="mt-3 flex flex-wrap items-center gap-2 text-xs"
            role="group"
            aria-label="Filter by phase"
            data-testid="sync-phase-counts"
          >
            {counts.map(([phase, n]) => (
              <button
                key={phase}
                type="button"
                aria-pressed={phaseFilter === phase}
                onClick={() => setPhaseFilter(phaseFilter === phase ? null : phase)}
                className={`rounded-md border px-2 py-0.5 ${
                  phaseFilter === phase ? 'border-accent text-fg' : 'border-border text-fg-muted'
                } hover:border-accent`}
                data-testid={`sync-phase-filter-${phase}`}
              >
                {n} {phase.replace(/_/g, ' ')}
              </button>
            ))}
            {phaseFilter && (
              <button
                type="button"
                onClick={() => setPhaseFilter(null)}
                className="text-fg-muted underline"
                data-testid="sync-phase-filter-clear"
              >
                Show all
              </button>
            )}
          </div>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="Per-repo sync"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && allRepos.length === 0,
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
