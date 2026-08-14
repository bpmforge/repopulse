import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { DlqPanel } from './DlqPanel.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { formatLag, phaseSeverity, type OrgSyncStatus, type RepoSyncStatus } from './contracts.js';

// Admin → Sync (UX_SPEC §4.i, FR-INGEST-8). The warehouse-backed fallback the
// SSE stream degrades to: if the stream is down this page still tells the
// operator what is happening, which is the whole point of having both.

export function SyncOps() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSyncStatus>({
    endpoint: '/sync/status',
  });

  const repos = data?.repos ?? [];

  const columns: DataTableColumn<RepoSyncStatus>[] = [
    { id: 'repo', header: 'Repo', cell: (row) => row.repoId },
    {
      id: 'phase',
      header: 'Phase',
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          <SeverityBadge severity={phaseSeverity(row.phase)} />
          <span>{row.phase.replace(/_/g, ' ')}</span>
        </span>
      ),
    },
    {
      id: 'pct',
      header: 'Progress',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{Math.round(row.percentComplete)}%</span>,
    },
    {
      id: 'budget',
      header: 'Budget left',
      align: 'right',
      // Rate-limit budget is law (Law 7); an operator needs to see it before a
      // repo goes paused_budget, not after.
      cell: (row) => (
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
      id: 'error',
      header: 'Last error',
      cell: (row) =>
        row.lastError ? (
          <span className="text-crit" title={row.lastError.at}>
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
        {...(error ? { errorMessage: error.message } : {})}
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
              <dt className="text-xs text-fg-muted">Complete</dt>
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
        {...(error ? { errorMessage: error.message } : {})}
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
