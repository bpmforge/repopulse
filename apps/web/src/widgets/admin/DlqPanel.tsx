import {
  DataTable,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import type { Toast } from '../../components/store/uiStore.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Sync → Dead-letter queue (W4-20, NFR-11).
//
// W12-05 made the DLQ a deliberate SINK: exhausted jobs are copied there and
// nothing consumes them, precisely so a human can look. This panel is the
// looking. Until it existed, a job that ran out of retries landed somewhere no
// operator could see.

const LIST = { endpoint: '/admin/dlq' } as const;

export interface DlqRow {
  id: number;
  queue: string;
  job_id: string;
  error: string;
  failed_at: string;
  replayed_at: string | null;
}

function ReplayButton({ row, onToast }: { row: DlqRow; onToast: (t: Toast[]) => void }) {
  // Per-row hook: the descriptor fixes the URL when the hook is created, so one
  // shared mutation cannot carry a per-row id.
  const replay = useApiMutation<Record<string, never>, { id: number; replayed: boolean }>(
    { endpoint: '/admin/dlq/{id}/replay', path: { id: row.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  return (
    <button
      type="button"
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
      data-testid={`dlq-replay-${row.id}`}
      disabled={replay.isPending}
      onClick={() =>
        replay.mutate(
          {},
          {
            onError: (err: Error) =>
              onToast([{ id: `dlq-${row.id}-err`, tone: 'crit', message: err.message }]),
            onSuccess: () =>
              onToast([{ id: `dlq-${row.id}-ok`, tone: 'ok', message: `Replayed ${row.job_id}` }]),
          },
        )
      }
    >
      Replay
    </button>
  );
}

export function DlqPanel() {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: DlqRow[] }>(LIST);
  const items = data?.items ?? [];

  const columns: DataTableColumn<DlqRow>[] = [
    { id: 'queue', header: 'Queue', cell: (row) => row.queue },
    { id: 'job', header: 'Job', cell: (row) => row.job_id },
    {
      id: 'error',
      // The REASON, not just a count. A dead-letter list that shows how many
      // jobs failed and not why tells an operator nothing they can act on.
      header: 'Error',
      cell: (row) => (
        <span className="block max-w-md truncate" title={row.error}>
          {row.error}
        </span>
      ),
    },
    { id: 'failed', header: 'Failed', cell: (row) => new Date(row.failed_at).toLocaleString() },
    { id: 'action', header: 'Replay', cell: (row) => <ReplayButton row={row} onToast={pushToasts} /> },
  ];

  return (
    <WidgetFrame
      title="Dead-letter queue"
      state={frameState({ isLoading, isError, isEmpty: items.length === 0 })}
      {...(error ? { errorMessage: error.message } : {})}
      onRetry={() => void refetch()}
      // An empty DLQ is GOOD NEWS and should read that way — not as a screen
      // that failed to load.
      emptyMessage="No dead-lettered jobs. Anything that exhausts its retries will appear here with the error that caused it."
    >
      <div data-testid="dlq-table">
        <DataTable name="admin-dlq" columns={columns} data={items} getRowId={(row) => String(row.id)} />
      </div>
    </WidgetFrame>
  );
}
