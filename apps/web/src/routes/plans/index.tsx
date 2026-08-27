import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { PlanItemCard } from '../../widgets/plans/PlanItemCard.js';
import { planProgress, type Plan } from '../../widgets/plans/contracts.js';

// Plans page (W5-07, UX_SPEC §4.h2). The rail has linked to /plans since W4-02
// with no route behind it.

export const Route = createFileRoute('/plans/')({ component: PlansPage });

const LIST = { endpoint: '/plans' } as const;

function PlansPage() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Plan[] }>(LIST);
  const generate = useApiMutation<{ window: string }, { id: number }>(
    { endpoint: '/plans', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const plans = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="plans">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold">Improvement plans</h1>
        <button
          type="button"
          className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="generate-plan"
          disabled={generate.isPending}
          onClick={() => generate.mutate({ window: '30d' })}
        >
          Generate plan
        </button>
      </div>

      <WidgetFrame
        title="Plans"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && plans.length === 0 })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No plans yet. Generate one from the current metrics — items are proposed only where a threshold is actually breached, so a healthy workspace produces an empty plan."
      >
        <div className="flex flex-col gap-4">
          {plans.map((plan) => {
            const progress = planProgress(plan);
            // Regressed first, then rank. Something that came undone outranks
            // new advice: it is work already paid for that is being lost.
            const items = [...plan.items]
              .filter((i) => i.status !== 'dismissed')
              .sort((a, b) => {
                const ra = a.status === 'regressed' ? 0 : 1;
                const rb = b.status === 'regressed' ? 0 : 1;
                return ra - rb || a.rank - b.rank;
              });

            return (
              <section key={plan.id} data-testid={`plan-${plan.id}`}>
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <h2 className="text-sm font-medium">
                    {plan.window} · {plan.repo_ids.length > 0 ? `${plan.repo_ids.length} repos` : 'all repos'}
                  </h2>
                  <span className="text-xs text-fg-muted" data-testid={`plan-progress-${plan.id}`}>
                    {progress.done}/{progress.total} verified
                  </span>
                  {progress.regressed > 0 && (
                    <span className="text-xs text-warn" data-testid={`plan-regressed-${plan.id}`}>
                      ⚠ {progress.regressed} regressed
                    </span>
                  )}
                  <span className="text-xs text-fg-faint">catalog {plan.catalog_version}</span>
                </div>

                {/* Progress bar with its numbers beside it: a bar alone cannot
                    be read by a screen reader or a printout. */}
                <div
                  className="mb-2 h-2 w-full overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuenow={progress.done}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(progress.total, 1)}
                  aria-label={`${progress.done} of ${progress.total} items verified`}
                >
                  <div
                    className="h-full bg-ok"
                    style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                  />
                </div>

                {items.length > 0 ? (
                  <ul className="flex flex-col gap-2" data-testid={`plan-items-${plan.id}`}>
                    {items.map((item) => (
                      <PlanItemCard key={item.id} item={item} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Nothing outstanding in this plan — every threshold in the catalog is currently met.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </WidgetFrame>
    </div>
  );
}
