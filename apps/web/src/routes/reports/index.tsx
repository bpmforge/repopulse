import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Report Center (W5-04, UX_SPEC §4.h). The rail has linked to /reports since
// W4-02 with no route behind it.

export const Route = createFileRoute('/reports/')({ component: ReportCenter });

const LIST = { endpoint: '/reports' } as const;

interface ReportRow {
  id: number;
  type: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  generated_at: string;
  error: string | null;
  has_pdf: boolean;
}

const TYPES = [
  { id: 'repo_health', label: 'Repository Health' },
  { id: 'org_exec', label: 'Organisation Executive Summary' },
  { id: 'delivery_dora', label: 'Delivery / DORA' },
  { id: 'security_posture', label: 'Security Posture' },
  { id: 'code_health', label: 'Code Health' },
] as const;

/** Paired glyph + word, never colour alone (UX_SPEC §7). */
const STATUS: Record<ReportRow['status'], string> = {
  queued: '◷ queued',
  running: '◐ running',
  ready: '✓ ready',
  failed: '✕ failed',
};

function ReportCenter() {
  const [type, setType] = useState<string>('repo_health');
  const [windowDays, setWindowDays] = useState(30);

  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: ReportRow[] }>(LIST, {
    // Generation is asynchronous and this list is how anyone knows it finished.
    // Polling rather than SSE because a report takes seconds, not minutes, and
    // a dedicated event channel for it would be more moving parts than the
    // problem deserves.
    refetchInterval: 3000,
  });

  const [annotation, setAnnotation] = useState('');
  const [compare, setCompare] = useState<number[]>([]);

  const generate = useApiMutation<{ type: string; window_days: number; annotation: string }, { id: number }>(
    { endpoint: '/reports', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="report-center">
      <WidgetFrame title="Generate a report" state="ready">
        <div className="flex flex-wrap items-end gap-3" data-testid="generate-form">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Report
            <select
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
              className="w-72 rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
              generate.mutate({ type, window_days: windowDays, annotation }, { onSuccess: () => setAnnotation('') })
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
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No reports yet — generate one above."
      >
        <table className="w-full text-sm">
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
              <tr key={r.id} className="border-t border-border" data-testid={`report-${r.id}`}>
                <th scope="row" className="py-1 text-left font-normal">
                  {TYPES.find((t) => t.id === r.type)?.label ?? r.type}
                </th>
                <td className="py-1 text-xs">{r.generated_at.slice(0, 16).replace('T', ' ')}</td>
                <td className="py-1" data-testid={`report-status-${r.id}`}>
                  {STATUS[r.status] ?? r.status}
                  {/* The reason travels with the failure. A bare "failed" sends
                      someone to logs they may not have access to. */}
                  {r.error && <span className="ml-2 text-xs text-crit">{r.error.slice(0, 120)}</span>}
                </td>
                <td className="py-1">
                  <input
                    type="checkbox"
                    aria-label={`Compare report ${r.id}`}
                    data-testid={`report-compare-${r.id}`}
                    disabled={r.status !== 'ready'}
                    checked={compare.includes(r.id)}
                    onChange={(e) =>
                      setCompare((c) =>
                        e.target.checked ? [...c, r.id].slice(-2) : c.filter((id) => id !== r.id),
                      )
                    }
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
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>

      {compare.length === 2 && <ReportDiff before={compare[0]!} after={compare[1]!} />}
    </div>
  );
}

interface DiffResponse {
  comparable: boolean;
  reason?: string;
  deltas: { sectionId: string; label: string; before: number | null; after: number | null; delta: number | null; onlyOneSide: boolean }[];
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
      state={frameState({ isLoading, isError, isEmpty: data?.comparable === true && data.deltas.length === 0 })}
      {...(error ? { errorMessage: error.message } : {})}
      emptyMessage="These reports contain no comparable rows."
    >
      {data?.comparable === false ? (
        // Refusing is the honest answer: a diff across scopes would render a
        // change in what was measured as a change in the work.
        <p className="text-sm text-fg-muted" data-testid="diff-refused">
          {data.reason}
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="diff-table">
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
                <th scope="row" className="py-1 text-left font-normal">{d.label}</th>
                <td className="py-1 tabular-nums">{d.before ?? '—'}</td>
                <td className="py-1 tabular-nums">{d.after ?? '—'}</td>
                <td className="py-1 tabular-nums">
                  {d.delta === null
                    ? // Never rendered as a number: a row present on one side
                      // only has not moved, it has appeared or gone.
                      (d.onlyOneSide ? (d.after === null ? 'gone' : 'new') : '—')
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
