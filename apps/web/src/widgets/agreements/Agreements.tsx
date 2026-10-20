import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
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

interface Kind {
  id: string;
  label: string;
  unit: string;
  key: string;
  /** The default the API applies to a blank value, in the units shown. */
  placeholder: number;
  /** Shown as a percentage, stored as a fraction (W20-17, UX_TODO ADM-65). */
  percent?: boolean;
  /** Whole numbers only. */
  whole?: boolean;
  min: number;
}

const KINDS: Kind[] = [
  {
    id: 'pr_size_max',
    label: 'Pull requests stay under',
    unit: 'lines changed',
    key: 'lines',
    placeholder: 500,
    whole: true,
    min: 1,
  },
  {
    id: 'review_within_hours',
    label: 'First review within',
    unit: 'hours',
    key: 'hours',
    placeholder: 24,
    min: 0,
  },
  {
    id: 'no_unreviewed_merge',
    label: 'No merge without',
    unit: 'review(s)',
    key: 'minReviews',
    placeholder: 1,
    whole: true,
    min: 1,
  },
  {
    id: 'stale_ceiling',
    label: 'Stale pull requests stay under',
    unit: 'open',
    key: 'count',
    placeholder: 10,
    whole: true,
    min: 0,
  },
  {
    id: 'ci_pass_floor',
    label: 'CI pass rate stays above',
    unit: '%',
    key: 'rate',
    placeholder: 90,
    percent: true,
    min: 0,
  },
];

const AGGREGATE = new Set(['stale_ceiling', 'ci_pass_floor']);

/**
 * The typed value as the stored threshold, or the problem with it (W20-17,
 * UX_TODO ADM-14/65). Blank means the default; the API checks the same ranges.
 */
export function parseThreshold(
  kind: Kind,
  raw: string,
): { threshold: Record<string, number> } | { problem: string } {
  if (raw.trim() === '') return { threshold: {} };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { problem: 'Enter a number, or leave it blank for the default.' };
  if (kind.percent) {
    if (n <= 0 || n > 100) return { problem: 'Enter a percentage between 1 and 100.' };
    return { threshold: { [kind.key]: n / 100 } };
  }
  if (kind.whole && !Number.isInteger(n)) return { problem: 'Enter a whole number.' };
  if (kind.whole && n < kind.min) return { problem: `Enter ${kind.min} or more.` };
  if (!kind.whole && n <= 0) return { problem: 'Enter a number greater than 0.' };
  return { threshold: { [kind.key]: n } };
}

/** The stored threshold in the units the form shows. */
function shownValue(kind: Kind | undefined, a: Agreement): string {
  const stored = Object.values(a.threshold)[0];
  if (typeof stored !== 'number') return `${kind?.placeholder ?? ''} (default)`;
  return kind?.percent ? String(Math.round(stored * 1000) / 10) : String(stored);
}

export function Agreements() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Agreement[] }>(LIST);
  const [kind, setKind] = useState(KINDS[0]!.id);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

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
              className="panel px-2 py-1 text-sm"
              data-testid="agreement-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setProblem(null);
              }}
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
              className="w-28 panel px-2 py-1 text-sm"
              data-testid="agreement-threshold"
              placeholder={String(chosen.placeholder)}
              value={value}
              aria-invalid={problem !== null}
              aria-describedby="agreement-default"
              onChange={(e) => {
                setValue(e.target.value);
                setProblem(null);
              }}
            />
          </label>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="agreement-create"
            disabled={create.isPending}
            onClick={() => {
              // Blank means "use the documented default" rather than zero —
              // a zero threshold would make every pull request an exception.
              const parsed = parseThreshold(chosen, value);
              if ('problem' in parsed) {
                setProblem(parsed.problem);
                return;
              }
              create.mutate(
                { kind, threshold: parsed.threshold },
                { onSuccess: () => setValue('') },
              );
            }}
          >
            Add
          </button>
        </div>
        {/* W20-17 (UX_TODO ADM-14): what a blank value means, and why Add
            refused. Both were silent. */}
        <p id="agreement-default" className="mt-2 text-xs text-fg-muted">
          Leave the value blank to use the default ({chosen.placeholder} {chosen.unit}).
        </p>
        {problem && (
          <p className="mt-1 text-xs text-crit" role="alert" data-testid="agreement-problem">
            {problem}
          </p>
        )}
        <ErrorNote
          error={create.error}
          testId="agreement-create-error"
          className="mt-1"
          withDetail
        />
      </WidgetFrame>

      <WidgetFrame
        title="Active agreements"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No agreements yet. They are your team's own thresholds — the product does not impose one."
      >
        <ul className="flex flex-col gap-3" data-testid="agreement-list">
          {items.map((a) => (
            <AgreementItem key={a.id} agreement={a} />
          ))}
        </ul>
      </WidgetFrame>
    </div>
  );
}

function AgreementItem({ agreement: a }: { agreement: Agreement }) {
  const meta = KINDS.find((k) => k.id === a.kind);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const item = { endpoint: '/agreements/{id}', path: { id: a.id } } as const;
  const patch = useApiMutation<{ active?: boolean; threshold?: Record<string, number> }, unknown>(
    { ...item, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const remove = useApiMutation<void, unknown>(
    { ...item, method: 'DELETE' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const n = a.exception_count;

  return (
    <li className="panel p-3" data-testid={`agreement-${a.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {meta?.label ?? a.kind} <span className="tabular-nums">{shownValue(meta, a)}</span>{' '}
          <span className="text-xs text-fg-muted">{meta?.unit}</span>
          {!a.active && (
            <span className="ml-2 text-xs text-fg-muted" data-testid={`agreement-paused-${a.id}`}>
              · paused
            </span>
          )}
        </h3>
        {/* Paired mark + text, never colour alone (UX_SPEC §7). Pluralised
            (W20-17, UX_TODO ADM-37). */}
        {a.active && (
          <span className="text-xs" data-testid={`agreement-count-${a.id}`}>
            {n === 0 ? '✓ no exceptions' : `⚠ ${n} exception${n === 1 ? '' : 's'}`}
          </span>
        )}
        <span className="text-xs text-fg-faint">last {a.window_days}d</span>
      </div>

      {/* W20-17 (UX_TODO ADM-14): edit, pause and delete. The API had PATCH
          and DELETE all along; a typo meant a permanent extra agreement. */}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {editing && meta ? (
          <>
            <label className="flex items-center gap-1 text-fg-muted">
              New value ({meta.unit})
              <input
                type="number"
                step="any"
                className="w-24 panel px-2 py-0.5 text-sm"
                data-testid={`agreement-edit-value-${a.id}`}
                placeholder={String(meta.placeholder)}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setProblem(null);
                }}
              />
            </label>
            <button
              type="button"
              className="text-accent hover:underline disabled:opacity-50"
              data-testid={`agreement-save-${a.id}`}
              disabled={patch.isPending}
              onClick={() => {
                const parsed = parseThreshold(meta, draft);
                if ('problem' in parsed) {
                  setProblem(parsed.problem);
                  return;
                }
                patch.mutate(
                  { threshold: parsed.threshold },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="text-fg-muted hover:underline"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-accent hover:underline"
            data-testid={`agreement-edit-${a.id}`}
            onClick={() => {
              setDraft(shownValue(meta, a).replace(/ \(default\)$/, ''));
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="text-accent hover:underline disabled:opacity-50"
          data-testid={`agreement-toggle-${a.id}`}
          disabled={patch.isPending}
          onClick={() => patch.mutate({ active: !a.active })}
        >
          {a.active ? 'Pause' : 'Resume'}
        </button>
        {confirmDelete ? (
          <span role="group" aria-label="Confirm delete" className="flex items-center gap-2">
            <span className="text-fg-muted">Delete this agreement for everyone?</span>
            <button
              type="button"
              className="text-crit hover:underline disabled:opacity-50"
              data-testid={`agreement-delete-confirm-${a.id}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined)}
              // The confirmation is the one thing to answer (ADM-69's rule).
              autoFocus
            >
              Delete
            </button>
            <button
              type="button"
              className="text-fg-muted hover:underline"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="text-crit hover:underline"
            data-testid={`agreement-delete-${a.id}`}
            onClick={() => setConfirmDelete(true)}
          >
            Delete…
          </button>
        )}
      </div>
      {problem && (
        <p className="mt-1 text-xs text-crit" role="alert">
          {problem}
        </p>
      )}
      <ErrorNote
        error={patch.error}
        testId={`agreement-patch-error-${a.id}`}
        className="mt-1"
        withDetail
      />
      <ErrorNote
        error={remove.error}
        testId={`agreement-delete-error-${a.id}`}
        className="mt-1"
        withDetail
      />

      {!a.active ? null : a.exceptions.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid={`agreement-exceptions-${a.id}`}>
          {a.exceptions.map((e) => (
            <li key={`${e.repo_id}-${e.pr_number}`} className="text-xs">
              <span className="text-fg-muted">{e.repo}</span>{' '}
              {/* Router Link (ADM-37): a plain <a> reloaded the whole app. */}
              <Link
                to="/repos/$repoId/prs/$number"
                params={{ repoId: String(e.repo_id), number: String(e.pr_number) }}
                className="text-accent underline underline-offset-2 hover:text-fg"
              >
                #{e.pr_number}
              </Link>{' '}
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
}
