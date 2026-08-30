import { useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import {
  criterionInWords,
  metricInWords,
  type MetricNames,
  type PlanItem,
} from './contracts.js';

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

export function PlanItemCard({ item, metricNames }: { item: PlanItem; metricNames?: MetricNames }) {
  const transition = useApiMutation<{ status: string }, unknown>(
    { endpoint: '/plans/items/{id}', path: { id: item.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const regressed = item.status === 'regressed';

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
              onClick={() => transition.mutate({ status: 'dismissed' })}
            >
              Dismiss
            </button>
          </>
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
            would make the whole verification story decorative. */}
        {(item.status === 'in_progress' || item.status === 'done') && (
          <span className="text-xs text-fg-faint">
            {item.status === 'done'
              ? `Verified ${item.verified_at?.slice(0, 10) ?? ''}`
              : 'Closes automatically once the metric holds.'}
          </span>
        )}
      </div>
    </li>
  );
}
