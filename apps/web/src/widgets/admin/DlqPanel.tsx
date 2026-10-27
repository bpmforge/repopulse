import { useState } from 'react';
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

// Settings → Sync → Dead-letter queue (W4-20, NFR-11).
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
  /** What the job was for (W20-22, UX_TODO ADM-53). */
  target?: {
    repo_id: number | null;
    repo: string | null;
    /** The repository is gone: this job can never succeed. */
    repo_removed: boolean;
    detail: string | null;
  };
}

/** "acme/api · pull request #12", or what is known (W20-22, ADM-53). */
export function targetText(row: Pick<DlqRow, 'target'>): string {
  const t = row.target;
  if (!t) return '—';
  const repo = t.repo ?? (t.repo_removed ? `repository ${t.repo_id} (removed)` : null);
  const parts = [repo, t.detail].filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/**
 * Drop a job that can never succeed (W20-22, UX_TODO ADM-53), with a reason
 * the audit log keeps. The list only grew: a job whose repository was removed
 * sat there for good.
 */
function DiscardButton({ row, onToast }: { row: DlqRow; onToast: (t: Toast[]) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(
    row.target?.repo_removed ? 'Its repository was removed' : '',
  );
  const discard = useApiMutation<{ reason: string }, { id: number; discarded: boolean }>(
    { endpoint: '/admin/dlq/{id}/discard', path: { id: row.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  if (!open) {
    return (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-crit focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid={`dlq-discard-${row.id}`}
        onClick={() => setOpen(true)}
      >
        Discard…
      </button>
    );
  }
  const inputId = `dlq-discard-reason-${row.id}`;
  return (
    <div className="flex max-w-xs flex-col gap-1" data-testid={`dlq-discard-form-${row.id}`}>
      <label htmlFor={inputId} className="text-xs text-fg-muted">
        Why discard it? (kept in the audit log)
      </label>
      <input
        id={inputId}
        className="panel px-2 py-1 text-xs"
        // The one thing to answer (ADM-69's rule).
        autoFocus
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        data-testid={`dlq-discard-reason-${row.id}`}
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={reason.trim() === '' || discard.isPending}
          className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10 disabled:opacity-50"
          data-testid={`dlq-discard-do-${row.id}`}
          onClick={() =>
            discard.mutate(
              { reason: reason.trim() },
              {
                onError: (err: Error) => onToast([errorToast(`dlq-${row.id}-discard-err`, err)]),
                onSuccess: () =>
                  onToast([
                    {
                      id: `dlq-${row.id}-discard-ok`,
                      tone: 'ok',
                      message: `Discarded ${row.job_id}`,
                    },
                  ]),
              },
            )
          }
        >
          {discard.isPending ? 'Discarding…' : 'Discard'}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
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
    {
      // W20-22 (UX_TODO ADM-53): which repository or report it was for.
      id: 'target',
      header: 'For',
      cell: (row) => (
        <span
          className={row.target?.repo_removed ? 'text-fg-muted' : ''}
          data-testid={`dlq-target-${row.id}`}
        >
          {targetText(row)}
        </span>
      ),
    },
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
      header: 'Actions',
      cell: (row) => (
        <div className="flex flex-wrap items-start gap-1.5">
          {/* A job for a removed repository cannot succeed; offer only Discard. */}
          {!row.target?.repo_removed && <ReplayButton row={row} onToast={pushToasts} />}
          <DiscardButton row={row} onToast={pushToasts} />
        </div>
      ),
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
