import {
  DataTable,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import { errorToast, type Toast } from '../../components/store/uiStore.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { ErrorDetails } from './ErrorDetails.js';

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

  // INS-45: a replayed row says so (and when), so nobody replays it twice
  // wondering whether the first click did anything.
  const replayedAt = row.replayed_at;
  return (
    <div className="flex flex-col items-start gap-0.5">
      {replayedAt ? (
        <span className="text-xs text-fg-muted" data-testid={`dlq-replayed-${row.id}`}>
          Replayed {new Date(replayedAt).toLocaleString()}
        </span>
      ) : null}
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid={`dlq-replay-${row.id}`}
        disabled={replay.isPending}
        onClick={() =>
          replay.mutate(
            {},
            {
              // W20-04 (UX_TODO ADM-12): title, detail and request id, not the title alone.
              onError: (err: Error) => onToast([errorToast(`dlq-${row.id}-err`, err)]),
              onSuccess: () =>
                onToast([
                  { id: `dlq-${row.id}-ok`, tone: 'ok', message: `Replayed ${row.job_id}` },
                ]),
            },
          )
        }
      >
        {replay.isPending ? 'Replaying…' : replayedAt ? 'Replay again' : 'Replay'}
      </button>
    </div>
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
      // ADM-16: expandable, not truncated behind a mouse-only tooltip.
      cell: (row) => <ErrorDetails message={row.error} testId={`dlq-error-${row.id}`} />,
    },
    { id: 'failed', header: 'Failed', cell: (row) => new Date(row.failed_at).toLocaleString() },
    {
      id: 'action',
      header: 'Replay',
      cell: (row) => <ReplayButton row={row} onToast={pushToasts} />,
    },
  ];

  return (
    <WidgetFrame
      title="Dead-letter queue"
      state={frameState({ isLoading, isError, isEmpty: items.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      // An empty DLQ is GOOD NEWS and should read that way — not as a screen
      // that failed to load.
      emptyMessage="No dead-lettered jobs. Anything that exhausts its retries will appear here with the error that caused it."
    >
      <div data-testid="dlq-table">
        <DataTable
          name="admin-dlq"
          columns={columns}
          data={items}
          getRowId={(row) => String(row.id)}
        />
      </div>
    </WidgetFrame>
  );
}
