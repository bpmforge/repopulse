import { useState } from 'react';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Working agreements admin (W5-08, FR-PLANS-4).
//
// The exception list is the point of the screen. A threshold with a count next
// to it is a scoreboard; a threshold with the four actual pull requests beneath
// it is something a team can sit down and talk about (N-9, R-5).

const LIST = { endpoint: '/agreements' } as const;

interface AgreementException {
  repo: string;
  repo_id: number;
  pr_number: number;
  title: string;
  detail: string;
}

interface Agreement {
  id: number;
  kind: string;
  threshold: Record<string, unknown>;
  active: boolean;
  window_days: number;
  exception_count: number;
  exceptions: AgreementException[];
}

const KINDS: { id: string; label: string; unit: string; key: string; placeholder: number }[] = [
  { id: 'pr_size_max', label: 'Pull requests stay under', unit: 'lines changed', key: 'lines', placeholder: 500 },
  { id: 'review_within_hours', label: 'First review within', unit: 'hours', key: 'hours', placeholder: 24 },
  { id: 'no_unreviewed_merge', label: 'No merge without', unit: 'review(s)', key: 'minReviews', placeholder: 1 },
  { id: 'stale_ceiling', label: 'Stale pull requests stay under', unit: 'open', key: 'count', placeholder: 10 },
  { id: 'ci_pass_floor', label: 'CI pass rate stays above', unit: 'rate 0–1', key: 'rate', placeholder: 0.9 },
];

const AGGREGATE = new Set(['stale_ceiling', 'ci_pass_floor']);

export function Agreements() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Agreement[] }>(LIST);
  const [kind, setKind] = useState(KINDS[0]!.id);
  const [value, setValue] = useState('');

  const create = useApiMutation<{ kind: string; threshold: Record<string, number> }, unknown>(
    { endpoint: '/agreements', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const chosen = KINDS.find((k) => k.id === kind)!;
  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="agreements">
      <WidgetFrame title="Add an agreement" state="ready">
        <div className="flex flex-wrap items-end gap-3" data-testid="agreement-form">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Agreement
            <select
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
              data-testid="agreement-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {chosen.unit}
            <input
              type="number"
              step="any"
              className="w-28 rounded-md border border-border bg-surface px-2 py-1 text-sm"
              data-testid="agreement-threshold"
              placeholder={String(chosen.placeholder)}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="agreement-create"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                {
                  kind,
                  // Blank means "use the documented default" rather than zero —
                  // a zero threshold would make every pull request an exception.
                  threshold: value.trim() === '' ? {} : { [chosen.key]: Number(value) },
                },
                { onSuccess: () => setValue('') },
              )
            }
          >
            Add
          </button>
        </div>
      </WidgetFrame>

      <WidgetFrame
        title="Active agreements"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No agreements yet. They are your team's own thresholds — the product does not impose one."
      >
        <ul className="flex flex-col gap-3" data-testid="agreement-list">
          {items.map((a) => {
            const meta = KINDS.find((k) => k.id === a.kind);
            return (
              <li key={a.id} className="rounded-md border border-border bg-surface p-3" data-testid={`agreement-${a.id}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="min-w-0 flex-1 text-sm font-medium">
                    {meta?.label ?? a.kind}{' '}
                    <span className="tabular-nums">
                      {String(Object.values(a.threshold)[0] ?? meta?.placeholder ?? '')}
                    </span>{' '}
                    <span className="text-xs text-fg-muted">{meta?.unit}</span>
                  </h3>
                  {/* Paired mark + text, never colour alone (UX_SPEC §7). */}
                  <span className="text-xs" data-testid={`agreement-count-${a.id}`}>
                    {a.exception_count === 0 ? '✓ no exceptions' : `⚠ ${a.exception_count} exceptions`}
                  </span>
                  <span className="text-xs text-fg-faint">last {a.window_days}d</span>
                </div>

                {a.exceptions.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1" data-testid={`agreement-exceptions-${a.id}`}>
                    {a.exceptions.map((e) => (
                      <li key={`${e.repo_id}-${e.pr_number}`} className="text-xs">
                        <span className="text-fg-muted">{e.repo}</span>{' '}
                        <a
                          href={`/repos/${e.repo_id}/prs/${e.pr_number}`}
                          className="text-accent hover:underline"
                        >
                          #{e.pr_number}
                        </a>{' '}
                        {e.title} — <span className="text-fg-muted">{e.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-fg-muted">
                    {AGGREGATE.has(a.kind)
                      ? // Not the same as "no violations": this kind is judged
                        // against a repository-level metric, not a PR list.
                        'This agreement is measured against a repository metric rather than individual pull requests.'
                      : 'No pull request breached this agreement in the window.'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </WidgetFrame>
    </div>
  );
}
