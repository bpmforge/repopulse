import { PULSE_METRICS } from './contracts.js';
import { TrendChart } from './TrendChart.js';

// Pulse tab (UX_SPEC §4.b): repo-scoped trend charts. The chart itself lives
// in TrendChart.tsx since W17-19, when the Performance tab needed it too.

interface Props {
  repoId: string;
  window: string;
}

export function RepoPulse({ repoId, window }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="repo-pulse">
      {PULSE_METRICS.map((metric) => (
        <TrendChart key={metric.key} repoId={repoId} window={window} metric={metric} />
      ))}
    </div>
  );
}
