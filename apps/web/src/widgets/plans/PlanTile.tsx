import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { registerWidget, type WidgetComponentProps } from '../../components/widget/WidgetRegistry.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { planProgress, type Plan } from './contracts.js';

// Org Overview plan tile (W5-07). Drills to the Plans page.

export function PlanTile(_props: WidgetComponentProps) {
  const { data, isLoading, isError, error } = useApiQuery<{ items: Plan[] }>({ endpoint: '/plans' });
  const plan = data?.items[0];
  const progress = plan ? planProgress(plan) : null;

  return (
    <WidgetFrame
      title="Improvement plan"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && !plan })}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="No plan yet — generate one from the Plans page."
    >
      {plan && progress && (
        <div className="flex flex-col gap-1" data-testid="plan-tile">
          <p className="text-[28px] leading-none tabular-nums">
            {progress.done}
            <span className="text-sm text-fg-muted">/{progress.total}</span>
          </p>
          <p className="text-xs text-fg-muted">items verified</p>
          {/* The worst news first, and never colour alone (UX_SPEC §7). */}
          {progress.regressed > 0 && (
            <p className="text-xs text-warn" data-testid="plan-tile-regressed">
              ⚠ {progress.regressed} regressed
            </p>
          )}
          <Link to="/plans" className="mt-1 text-xs text-accent hover:underline" data-testid="plan-tile-link">
            Open plan →
          </Link>
        </div>
      )}
    </WidgetFrame>
  );
}

registerWidget({
  type: 'plan-progress',
  title: 'Improvement plan',
  category: 'metrics',
  defaultSize: { w: 3, h: 2 },
  component: PlanTile,
});
