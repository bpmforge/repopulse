import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { FindingDetail } from '../../widgets/findings/FindingDetail.js';
import { TriageQueue } from '../../widgets/findings/TriageQueue.js';
import {
  SEVERITY_LABEL,
  VERIFY_LABEL,
  type Finding,
  type FindingStats,
} from '../../widgets/findings/contracts.js';

// Findings Explorer (W6-04, UX_SPEC §4.e, FR-WEB-9).
//
// The last of four rail destinations that linked nowhere since W4-02.

export const Route = createFileRoute('/findings/')({ component: FindingsExplorer });

const LIST = { endpoint: '/findings' } as const;
const DIMENSIONS = ['code_health', 'security', 'performance', 'test_coverage'] as const;
const STATUSES = ['open', 'confirmed', 'dismissed', 'resolved', 'wont_fix'] as const;

function FindingsExplorer() {
  const [dimension, setDimension] = useState('');
  const [status, setStatus] = useState('open');
  const [severityMin, setSeverityMin] = useState('');
  const [verifyStatus, setVerifyStatus] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [triage, setTriage] = useState(false);

  const listDescriptor = {
    endpoint: '/findings',
    query: {
      ...(dimension ? { dimension } : {}),
      ...(status ? { status } : {}),
      ...(severityMin ? { severity_min: severityMin } : {}),
      ...(verifyStatus ? { verify_status: verifyStatus } : {}),
    },
  } as const;

  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    items: Finding[];
    next_cursor: string | null;
  }>(listDescriptor);
  const { data: stats } = useApiQuery<FindingStats>({ endpoint: '/findings/stats' });

  const bulk = useApiMutation<{ ids: number[]; status: string; note: string }, unknown>(
    { endpoint: '/findings/bulk', method: 'POST' },
    {
      invalidate: [
        queryKeyFor(listDescriptor),
        queryKeyFor(LIST),
        queryKeyFor({ endpoint: '/findings/stats' }),
      ],
    },
  );

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="findings">
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="start-triage"
          disabled={items.length === 0}
          onClick={() => setTriage(true)}
        >
          Triage queue ({items.length})
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3" data-testid="finding-filters">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Dimension
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="filter-dimension"
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          >
            <option value="">Any</option>
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {d.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Status
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="filter-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Min severity
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="filter-severity"
            value={severityMin}
            onChange={(e) => setSeverityMin(e.target.value)}
          >
            <option value="">Any</option>
            {[5, 4, 3, 2].map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]} and above
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Verification
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="filter-verify"
            value={verifyStatus}
            onChange={(e) => setVerifyStatus(e.target.value)}
          >
            <option value="">Any</option>
            <option value="confirmed">Verified by a second model</option>
            <option value="unverified">Not independently verified</option>
            <option value="contradicted">Contradicted on review</option>
          </select>
        </label>
      </div>

      <WidgetFrame title="Analysis quality" state="ready">
        <div className="flex flex-wrap gap-6 text-sm" data-testid="fp-widget">
          <div>
            <p className="text-[28px] leading-none tabular-nums">
              {/* null, not 0: nothing reviewed yet must not read as a flawless
                  model (FR-INSIGHTS-1). */}
              {stats?.false_positive_rate === null || stats?.false_positive_rate === undefined
                ? '—'
                : `${Math.round(stats.false_positive_rate * 100)}%`}
            </p>
            <p className="text-xs text-fg-muted">
              {stats?.false_positive_rate === null
                ? 'no findings triaged yet'
                : 'dismissed as false positive'}
            </p>
          </div>
          <div>
            <p className="text-[28px] leading-none tabular-nums">{stats?.total ?? 0}</p>
            <p className="text-xs text-fg-muted">findings total</p>
          </div>
        </div>
      </WidgetFrame>

      {selected.length > 0 && (
        <WidgetFrame title={`${selected.length} selected`} state="ready">
          <div className="flex flex-wrap items-end gap-2" data-testid="bulk-bar">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Note (required)
              <input
                className="w-72 rounded-md border border-border bg-surface px-2 py-1 text-sm"
                data-testid="bulk-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {(['confirmed', 'dismissed'] as const).map((target) => (
              <button
                key={target}
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`bulk-${target}`}
                disabled={bulk.isPending || note.trim() === ''}
                onClick={() =>
                  bulk.mutate(
                    { ids: selected, status: target, note },
                    {
                      onSuccess: () => {
                        setSelected([]);
                        setNote('');
                      },
                    },
                  )
                }
              >
                Mark {target}
              </button>
            ))}
          </div>
        </WidgetFrame>
      )}

      <WidgetFrame
        title="Findings"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No findings match these filters. Findings appear once an analysis run completes for a repository."
      >
        <table className="w-full text-sm">
          <caption className="sr-only">Findings across every analysed repository</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col">Severity</th>
              <th scope="col">Finding</th>
              <th scope="col">Repository</th>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Verification</th>
            </tr>
          </thead>
          <tbody data-testid="finding-rows">
            {items.map((f) => (
              <tr key={f.id} className="border-t border-border" data-testid={`finding-${f.id}`}>
                <td className="py-1">
                  <input
                    type="checkbox"
                    aria-label={`Select finding ${f.id}`}
                    data-testid={`finding-select-${f.id}`}
                    checked={selected.includes(f.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, f.id] : s.filter((i) => i !== f.id),
                      )
                    }
                  />
                </td>
                {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                <td className="py-1 whitespace-nowrap">
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
                </td>
                <th scope="row" className="py-1 text-left font-normal">
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    data-testid={`finding-open-${f.id}`}
                    onClick={() => setOpenId(f.id === openId ? null : f.id)}
                  >
                    {f.title}
                  </button>
                </th>
                <td className="py-1 text-xs">{f.repo.name}</td>
                <td className="py-1 font-mono text-xs">
                  {f.file}:{f.line_range[0]}
                </td>
                <td className="py-1 text-xs">{f.status.replace('_', ' ')}</td>
                <td className="py-1 text-xs whitespace-nowrap" data-testid={`finding-verify-${f.id}`}>
                  {VERIFY_LABEL[f.verify_status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>

      {triage && (
        <TriageQueue
          findings={items}
          onExit={() => setTriage(false)}
          invalidate={[queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/findings/stats' })]}
        />
      )}

      {openId !== null && items.find((f) => f.id === openId) && (
        <FindingDetail
          finding={items.find((f) => f.id === openId)!}
          onClose={() => setOpenId(null)}
          invalidate={[queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/findings/stats' })]}
        />
      )}
    </div>
  );
}
