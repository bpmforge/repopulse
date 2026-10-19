import { useState } from 'react';
import { useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
import {
  criterionInWords,
  findingIdsOf,
  metricInWords,
  progressInWords,
  type MetricNames,
  type PlanItem,
} from './contracts.js';
import { InternalLink } from './InternalLink.js';

// One ranked plan item (W5-07, UX_SPEC §4.h2).

const LIST = { endpoint: '/plans' } as const;

const EFFORT: Record<PlanItem['effort'], string> = { S: 'Small', M: 'Medium', L: 'Large' };

/** Paired glyph + word — never colour alone (UX_SPEC §7). */
const STATUS_LABEL: Record<PlanItem['status'], string> = {
  proposed: '○ proposed',
  accepted: '◔ accepted',
  in_progress: '◐ in progress',
  done: '✓ done',
  regressed: '⚠ regressed',
  dismissed: '– dismissed',
};

export function PlanItemCard({
  item,
  metricNames,
  scopeLabel,
}: {
  item: PlanItem;
  metricNames?: MetricNames;
  /**
   * The plan's scope in words (W20-09, UX_TODO DSH-57), so the dismiss form
   * can say what it will hide BEFORE it hides it.
   */
  scopeLabel?: string;
}) {
  const findingIds = findingIdsOf(item);
  const transition = useApiMutation<{ status: string; reason?: string }, unknown>(
    { endpoint: '/plans/items/{id}', path: { id: item.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  // W20-05 (UX_TODO DSH-14). Dismiss was one click with no reason and no way
  // back; a mis-click silently deleted a recommendation. It now asks why, and
  // the plans page lists dismissed items with Restore.
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');

  const regressed = item.status === 'regressed';
  // WHY it is where it is (W17-25): the verifier's last check, in words that
  // cite the number and the criterion. A human state gets no sentence.
  const progress = progressInWords(item, metricNames);

  return (
    <li
      className={`rounded-md border p-3 ${regressed ? 'border-warn/40 bg-warn/10' : 'border-border bg-surface'}`}
      data-testid={`plan-item-${item.id}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-fg-muted tabular-nums">#{item.rank}</span>
        <h3 className="min-w-0 flex-1 text-sm font-medium">{item.recommendation}</h3>
        <span className="text-xs text-fg-muted">{EFFORT[item.effort]} effort</span>
        <span className="text-xs" data-testid={`plan-item-status-${item.id}`}>
          {STATUS_LABEL[item.status]}
        </span>
      </div>

      {/* What "done" will mean, before anyone commits to it. */}
      <p className="mt-1 text-xs text-fg-muted" data-testid={`plan-item-criterion-${item.id}`}>
        {criterionInWords(item.verify_criterion, metricNames)}
      </p>

      {progress && (
        <p
          className={`mt-1 text-xs ${regressed ? 'text-warn' : 'text-fg-muted'}`}
          data-testid={`plan-item-progress-${item.id}`}
        >
          {progress}
        </p>
      )}

      {/* Evidence keys, not a copy of the data — the item points at the
          numbers that raised it so a reader can go and check. */}
      {Array.isArray(item.evidence.metricKeys) && (
        <p className="mt-1 text-xs text-fg-faint">
          Evidence:{' '}
          {(item.evidence.metricKeys as string[])
            .map((k) => metricInWords(k, metricNames))
            .join(', ')}
        </p>
      )}

      {/* The findings the generator clustered into this item (W17-24) — the
          ids the row carries, linked back to the review they came from. A
          metric item has none, and shows none. */}
      {findingIds.length > 0 && (
        <p className="mt-1 text-xs text-fg-faint" data-testid={`plan-item-findings-${item.id}`}>
          Findings:{' '}
          {findingIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <InternalLink
                to="/findings"
                search={{ finding: String(id) }}
                className="text-accent underline-offset-2 hover:underline"
                testId={`plan-item-finding-${item.id}-${id}`}
              >
                #{id}
              </InternalLink>
            </span>
          ))}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.status === 'proposed' && (
          <>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`plan-accept-${item.id}`}
              disabled={transition.isPending}
              onClick={() => transition.mutate({ status: 'accepted' })}
            >
              Accept
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`plan-dismiss-${item.id}`}
              disabled={transition.isPending}
              aria-expanded={dismissing}
              onClick={() => setDismissing((v) => !v)}
            >
              Dismiss…
            </button>
          </>
        )}
        {item.status === 'dismissed' && (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`plan-restore-${item.id}`}
            disabled={transition.isPending}
            onClick={() => transition.mutate({ status: 'proposed' })}
          >
            Restore
          </button>
        )}
        {item.status === 'accepted' && (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`plan-start-${item.id}`}
            disabled={transition.isPending}
            onClick={() => transition.mutate({ status: 'in_progress' })}
          >
            Start
          </button>
        )}
        {/* No "mark done" button anywhere, deliberately: an item closes when
            its metric actually moves (W5-06 nightly verify). A manual close
            would make the whole verification story decorative. The progress
            line above says what the last check saw. */}
        {item.status === 'in_progress' && (
          <span className="text-xs text-fg-faint">Closes automatically once the metric holds.</span>
        )}
      </div>

      {dismissing && item.status === 'proposed' && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          data-testid={`plan-dismiss-form-${item.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length === 0) return;
            transition.mutate(
              { status: 'dismissed', reason: reason.trim() },
              { onSuccess: () => setDismissing(false) },
            );
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-fg-muted">
            Why dismiss it? Kept in the item&apos;s history; you can restore it later.
            <span data-testid={`plan-dismiss-scope-${item.id}`}>
              {/* DSH-57: a dismissal used to hide the recommendation from every
                  future plan in the workspace. It now covers this plan's
                  repositories only, and says so here. */}
              Future plans for {scopeLabel ?? 'this scope'} will not propose it again; plans for
              other repositories still can.
            </span>
            <input
              type="text"
              className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
              data-testid={`plan-dismiss-reason-${item.id}`}
              value={reason}
              maxLength={500}
              required
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-crit/40 px-2 py-1 text-xs text-crit hover:border-crit focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            data-testid={`plan-dismiss-confirm-${item.id}`}
            disabled={transition.isPending || reason.trim().length === 0}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs"
            onClick={() => setDismissing(false)}
          >
            Keep it
          </button>
        </form>
      )}
      <ErrorNote error={transition.error} testId={`plan-item-error-${item.id}`} className="mt-2" />
    </li>
  );
}
