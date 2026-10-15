import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { registerWidget, type WidgetComponentProps } from '../../components/widget/WidgetRegistry.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { planProgress, planScopeLabel, type Plan } from './contracts.js';

// Org Overview plan tile (W5-07). Drills to the Plans page.

export function PlanTile(_props: WidgetComponentProps) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Plan[] }>({ endpoint: '/plans' });
  const plan = data?.items[0];
  const progress = plan ? planProgress(plan) : null;

  return (
    <WidgetFrame
      title="Improvement plan"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && !plan })}
      // W17-31: every failed frame offers Retry, like the rest of the overview.
      onRetry={() => void refetch()}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="No plan yet."
      // A way there, not directions to it (W18-28; UX_SPEC §4: "empty = one
      // line + next action"). The copy used to name the Plans page and stop.
      emptyAction={
        <Link to="/plans" className="text-sm text-accent hover:underline" data-testid="plan-tile-empty-link">
          Generate a plan →
        </Link>
      }
    >
      {plan && progress && (
        <div className="flex flex-col gap-1" data-testid="plan-tile">
          <p className="text-[28px] leading-none tabular-nums">
            {progress.done}
            <span className="text-sm text-fg-muted">/{progress.total}</span>
          </p>
          <p className="text-xs text-fg-muted">items verified</p>
          {/* The plan's own scope (W17-24): this tile sits on the ORG overview,
              and the newest plan may be one repository's. Said out loud, so a
              repository's 3/4 is not read as the organisation's. */}
          <p className="text-xs text-fg-faint" data-testid="plan-tile-scope">
            Scope: {planScopeLabel(plan.repo_ids)}
          </p>
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
