import { KpiRow } from '../org/KpiRow.js';
import { TopRisksCard } from '../risk/TopRisksCard.js';
import { PlanForRepoLink } from '../plans/PlanForRepoLink.js';
import { GeneratePlanButton } from '../plans/GeneratePlanButton.js';
import { PULSE_METRICS } from './contracts.js';
import { TrendChart } from './TrendChart.js';

// Pulse tab (UX_SPEC §4.b): repo-scoped trend charts. The chart itself lives
// in TrendChart.tsx since W17-19, when the Performance tab needed it too.
//
// WHAT TO DO NEXT FIRST (W20-09, UX_TODO DSH-12). Pulse was four trend charts:
// a tech lead opening a repository got state and no action. The current-value
// KPI row, this repository's Top risks and the way to its improvement plan
// now sit above the trends — the repo-scoped Top risks card and the plan link
// existed and were placed on no repository page.

interface Props {
  repoId: string;
  window: string;
}

export function RepoPulse({ repoId, window }: Props) {
  const id = Number(repoId);
  return (
    <div className="flex flex-col gap-4" data-testid="repo-pulse">
      <KpiRow window={window} repos={repoId} title="Current values" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TopRisksCard repoId={repoId} />
        <section className="panel flex flex-col gap-2 p-4" data-testid="repo-next-steps">
          <h2 className="text-sm font-medium">Improvement plan</h2>
          <p className="text-xs text-fg-muted">
            A plan ranks the fixes for the thresholds this repository is breaching, and closes each
            one when its number moves.
          </p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <PlanForRepoLink repoId={id} />
            {Number.isInteger(id) && <GeneratePlanButton window={window} repoIds={[id]} />}
          </div>
        </section>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="repo-pulse-trends">
        {PULSE_METRICS.map((metric) => (
          <TrendChart key={metric.key} repoId={repoId} window={window} metric={metric} />
        ))}
      </div>
    </div>
  );
}
