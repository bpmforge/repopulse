import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Report Center (W5-04, UX_SPEC §4.h). The rail has linked to /reports since
// W4-02 with no route behind it.

export const Route = createFileRoute('/reports/')({ component: ReportCenter });

const LIST = { endpoint: '/reports' } as const;

export interface ReportRow {
  id: number;
  type: string;
  /**
   * The four the worker writes. Typed open (W17-26) because the screen must
   * treat anything it does not recognise as SETTLED: a status added later
   * (`cancelled`, say) that this code kept polling on would be the infinite
   * poll all over again, under a new name.
   */
  status: 'queued' | 'running' | 'ready' | 'failed' | (string & {});
  generated_at: string;
  error: string | null;
  has_pdf: boolean;
  /** The row says ready, the PDF on disk is gone (W17-26). */
  artifact_missing?: boolean;
}

const TYPES = [
  { id: 'repo_health', label: 'Repository Health' },
  { id: 'org_exec', label: 'Organisation Executive Summary' },
  { id: 'delivery_dora', label: 'Delivery / DORA' },
  { id: 'security_posture', label: 'Security Posture' },
  { id: 'code_health', label: 'Code Health' },
] as const;

/** Paired glyph + word, never colour alone (UX_SPEC §7). */
const STATUS: Record<string, string> = {
  queued: '◷ queued',
  running: '◐ running',
  ready: '✓ ready',
  failed: '✕ failed',
  cancelled: '⊘ cancelled',
};

/**
 * How long a queued/running row is polled before the screen stops asking
 * (W17-26). A print takes seconds (REPORTS.md §3 budgets 30s) and BullMQ
 * retries it once after 5s; a row still non-terminal after this long is a
 * worker that died mid-job or a queue nobody is draining, and polling it for
 * the life of the tab is the infinite poll this ticket closes. The row stays
 * on screen with a Refresh so a human can still ask.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isPending(r: ReportRow): boolean {
  return r.status === 'queued' || r.status === 'running';
}

export function isStalled(r: ReportRow, now: number = Date.now()): boolean {
  return isPending(r) && now - Date.parse(r.generated_at) > STALE_AFTER_MS;
}

/** The poll interval for a list: 3s while any young job is in flight, else off. */
export function pollInterval(
  list: { items: ReportRow[] } | undefined,
  now: number = Date.now(),
): number | false {
  return list?.items.some((r) => isPending(r) && !isStalled(r, now)) ? 3000 : false;
}

/** A failed job, or a ready one whose PDF is gone, can be queued again. */
export function canRetry(r: ReportRow): boolean {
  return r.status === 'failed' || (r.status === 'ready' && r.artifact_missing === true);
}

function ReportCenter() {
  const [type, setType] = useState<string>('repo_health');
  const [windowDays, setWindowDays] = useState(30);

  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: ReportRow[] }>(LIST, {
    // Generation is asynchronous and this list is how anyone knows it finished.
    // Polling rather than SSE because a report takes seconds, not minutes, and
    // a dedicated event channel for it would be more moving parts than the
    // problem deserves.
    //
    // WHILE THERE IS SOMETHING TO WAIT FOR, and not otherwise (W16-12). The
    // old flat 3000 asked every three seconds for the life of the tab, long
    // after every report had settled. Terminal is anything that is not
    // queued/running, and a job non-terminal for longer than STALE_AFTER_MS
    // counts as settled too (W17-26).
    refetchInterval: (list) => pollInterval(list),
    // AND WHILE THE TAB IS HIDDEN. TanStack pauses the interval on
    // `visibilityState: 'hidden'` and defaults this to false — right for a
    // dashboard nobody is looking at, wrong for work the user asked for and
    // then switched away from. A report generated in a backgrounded tab
    // finished server-side and the row read "running" indefinitely.
    //
    // Safe to leave on precisely because the interval above stops itself: this
    // is a poll while a report is generating, not a permanent background
    // request from a tab nobody is looking at.
    refetchIntervalInBackground: true,
  });

  const [annotation, setAnnotation] = useState('');
  const [compare, setCompare] = useState<number[]>([]);

  const generate = useApiMutation<
    { type: string; window_days: number; annotation: string },
    { id: number }
  >({ endpoint: '/reports', method: 'POST' }, { invalidate: [queryKeyFor(LIST)] });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="report-center">
      <PageHeader
        title="Reports"
        description="Point-in-time reports, pinned to their window so a regenerated copy shows the same numbers."
      />
      <WidgetFrame title="Generate a report" state="ready">
        <div className="flex flex-wrap items-end gap-3" data-testid="generate-form">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Report
            <select
              className="panel px-2 py-1 text-sm"
              data-testid="report-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Window
            <select
              className="panel px-2 py-1 text-sm"
              data-testid="report-window"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            >
              {[7, 30, 90, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Context (optional)
            <input
              className="w-72 panel px-2 py-1 text-sm"
              data-testid="report-annotation"
              placeholder="e.g. this quarter includes the payments migration"
              value={annotation}
              onChange={(e) => setAnnotation(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="generate-report"
            disabled={generate.isPending}
            onClick={() =>
              generate.mutate(
                { type, window_days: windowDays, annotation },
                { onSuccess: () => setAnnotation('') },
              )
            }
          >
            Generate
          </button>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          The window and the snapshot high-watermark are pinned when you press Generate, so
          regenerating this report later reproduces the same numbers.
        </p>
      </WidgetFrame>

      <WidgetFrame
        title="History"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No reports yet — generate one above."
      >
        <table className="table-plain w-full text-sm">
          <caption className="sr-only">Generated reports, newest first</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Report</th>
              <th scope="col">Generated</th>
              <th scope="col">Status</th>
              <th scope="col">Compare</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="report-rows">
            {items.map((r) => (
              <HistoryRow
                key={r.id}
                row={r}
                compared={compare.includes(r.id)}
                onCompare={(checked) =>
                  setCompare((c) =>
                    checked ? [...c, r.id].slice(-2) : c.filter((id) => id !== r.id),
                  )
                }
                onRefresh={() => void refetch()}
              />
            ))}
          </tbody>
        </table>
      </WidgetFrame>

      {compare.length === 2 && <ReportDiff before={compare[0]!} after={compare[1]!} />}
    </div>
  );
}

function HistoryRow({
  row: r,
  compared,
  onCompare,
  onRefresh,
}: {
  row: ReportRow;
  compared: boolean;
  onCompare: (checked: boolean) => void;
  onRefresh: () => void;
}) {
  // Same row, queued again (W17-26): the pinned params travel with the id, so
  // a retry measures the same moment the failed run was asked to measure.
  const retry = useApiMutation<Record<string, never>, { id: number; status: string }>(
    { endpoint: '/reports/{id}/retry', path: { id: r.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const stalled = isStalled(r);

  return (
    <tr className="border-t border-border" data-testid={`report-${r.id}`}>
      <th scope="row" className="py-1 text-left font-normal">
        {TYPES.find((t) => t.id === r.type)?.label ?? r.type}
      </th>
      <td className="py-1 text-xs">{r.generated_at.slice(0, 16).replace('T', ' ')}</td>
      <td className="py-1" data-testid={`report-status-${r.id}`}>
        {STATUS[r.status] ?? r.status}
        {/* The reason travels with the failure. A bare "failed" sends
            someone to logs they may not have access to. */}
        {r.error && <span className="ml-2 text-xs text-crit">{r.error.slice(0, 120)}</span>}
        {r.status === 'ready' && r.artifact_missing && (
          // Not "failed": the generation succeeded and the stored data may
          // still be viewable. What is gone is the file behind the download.
          <span className="ml-2 text-xs text-warn" data-testid={`report-artifact-missing-${r.id}`}>
            PDF no longer on disk — retry to regenerate it
          </span>
        )}
        {stalled && (
          <span className="ml-2 text-xs text-fg-muted" data-testid={`report-stalled-${r.id}`}>
            no progress for over 15 minutes; polling paused
          </span>
        )}
        {retry.isError && (
          <span className="ml-2 text-xs text-crit" data-testid={`report-retry-error-${r.id}`}>
            {retry.error.message}
          </span>
        )}
      </td>
      <td className="py-1">
        <input
          type="checkbox"
          aria-label={`Compare report ${r.id}`}
          data-testid={`report-compare-${r.id}`}
          disabled={r.status !== 'ready'}
          checked={compared}
          onChange={(e) => onCompare(e.target.checked)}
        />
      </td>
      <td className="py-1">
        <div className="flex gap-2">
          <Link
            to="/print/reports/$reportId"
            params={{ reportId: String(r.id) }}
            className="text-xs text-accent hover:underline"
            data-testid={`report-view-${r.id}`}
          >
            View
          </Link>
          {r.has_pdf && (
            // A plain link, not fetch(): the download streams through
            // the API behind the session check, and letting the
            // browser handle it keeps a multi-megabyte PDF out of JS
            // memory.
            <a
              href={`/api/v1/reports/${r.id}/download`}
              className="text-xs text-accent hover:underline"
              data-testid={`report-download-${r.id}`}
            >
              PDF
            </a>
          )}
          {canRetry(r) && (
            <button
              type="button"
              className="text-xs text-accent hover:underline disabled:opacity-50"
              data-testid={`report-retry-${r.id}`}
              disabled={retry.isPending}
              onClick={() => retry.mutate({})}
            >
              Retry
            </button>
          )}
          {stalled && (
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              data-testid={`report-refresh-${r.id}`}
              onClick={onRefresh}
            >
              Refresh
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

interface DiffResponse {
  comparable: boolean;
  reason?: string;
  deltas: {
    sectionId: string;
    label: string;
    before: number | null;
    after: number | null;
    delta: number | null;
    onlyOneSide: boolean;
  }[];
}

/**
 * Diff of two stored reports (R-A9). Only possible because of the W5-03
 * determinism pin: two reports of the same scope differ where the numbers
 * moved, never because they were generated at different moments.
 */
function ReportDiff({ before, after }: { before: number; after: number }) {
  const { data, isLoading, isError, error } = useApiQuery<DiffResponse>({
    endpoint: '/reports/{id}/diff/{otherId}',
    path: { id: before, otherId: after },
  });

  return (
    <WidgetFrame
      title={`Comparing #${before} → #${after}`}
      state={frameState({
        isLoading,
        isError,
        isEmpty: data?.comparable === true && data.deltas.length === 0,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="These reports contain no comparable rows."
    >
      {data?.comparable === false ? (
        // Refusing is the honest answer: a diff across scopes would render a
        // change in what was measured as a change in the work.
        <p className="text-sm text-fg-muted" data-testid="diff-refused">
          {data.reason}
        </p>
      ) : (
        <table className="table-plain w-full text-sm" data-testid="diff-table">
          <caption className="sr-only">Per-row deltas between two reports</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Section</th>
              <th scope="col">Row</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {(data?.deltas ?? []).map((d, i) => (
              <tr key={`${d.sectionId}-${d.label}-${i}`} className="border-t border-border">
                <td className="py-1 text-xs text-fg-muted">{d.sectionId}</td>
                <th scope="row" className="py-1 text-left font-normal">
                  {d.label}
                </th>
                <td className="py-1 tabular-nums">{d.before ?? '—'}</td>
                <td className="py-1 tabular-nums">{d.after ?? '—'}</td>
                <td className="py-1 tabular-nums">
                  {d.delta === null
                    ? // Never rendered as a number: a row present on one side
                      // only has not moved, it has appeared or gone.
                      d.onlyOneSide
                      ? d.after === null
                        ? 'gone'
                        : 'new'
                      : '—'
                    : `${d.delta > 0 ? '▲' : d.delta < 0 ? '▼' : ''} ${Math.round(d.delta * 100) / 100}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </WidgetFrame>
  );
}
