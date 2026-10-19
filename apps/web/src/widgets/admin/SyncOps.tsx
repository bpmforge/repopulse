import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { DlqPanel } from './DlqPanel.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  formatLag,
  notEnabledText,
  phaseSeverity,
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

export function SyncOps() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSyncStatus>(
    { endpoint: '/sync/status' },
    { refetchInterval: syncPollInterval },
  );

  const repos = data?.repos ?? [];

  const columns: DataTableColumn<RepoSyncStatus>[] = [
    // W16-05 (F11): this showed the numeric id. Falls back to it only if an
    // older API is answering, rather than rendering `undefined`.
    { id: 'repo', header: 'Repo', cell: (row) => row.repoName ?? row.repoId },
    {
      id: 'phase',
      header: 'Phase',
      cell: (row) => (
        <SeverityBadge severity={phaseSeverity(row.phase)} label={row.phase.replace(/_/g, ' ')} />
      ),
    },
    {
      id: 'pct',
      // NOT "Progress" (W16-57). percentComplete is how far back the ingested
      // history reaches as a fraction of the 365-day backfill target — so a
      // repository that is fully caught up and phase `live` still reads 9% on a
      // fixture holding 40 days. Under a column called Progress that says the
      // sync is stuck, next to a phase saying it is finished.
      header: 'History of 1y',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{Math.round(row.percentComplete)}%</span>,
    },
    {
      id: 'budget',
      header: 'Budget left',
      align: 'right',
      // Rate-limit budget is law (Law 7); an operator needs to see it before a
      // repo goes paused_budget, not after.
      //
      // A ZERO LIMIT IS NOT A BUDGET (W16-57). The status endpoint documents
      // its budget as a placeholder — a runtime gauge that no table warehouses
      // yet — and served { remaining: 0, limit: 0 }, which rendered as "0/0":
      // indistinguishable from a repository that has exhausted its rate limit,
      // which is the one state this column exists to warn about.
      cell: (row) =>
        row.budget.limit === 0 ? (
          <span className="text-xs text-fg-muted">not recorded</span>
        ) : (
          <span className="tabular-nums">
            {row.budget.remaining}/{row.budget.limit}
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
      cell: (row) =>
        row.lastError ? (
          // The cell truncates; the full line (several fragments joined by
          // " · " — refusals, a stalled sync) is one hover away.
          <span className="text-crit" title={`${row.lastError.message}\n${row.lastError.at}`}>
            {row.lastError.message.slice(0, 60)}
          </span>
        ) : (
          '—'
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
              <dd data-testid="sync-phase">{data.phase.replace(/_/g, ' ')}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Repos</dt>
              <dd className="tabular-nums">{data.repoCount}</dd>
            </div>
            <div>
              {/* Same measure, same honesty as the column below (W16-57). */}
              <dt className="text-xs text-fg-muted">History of 1y</dt>
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
        emptyMessage="No repositories are syncing — connect an organisation first."
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
