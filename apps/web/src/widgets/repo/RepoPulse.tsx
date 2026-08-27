import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { PULSE_METRICS, scaleForUnit, type MetricSeries } from './contracts.js';

// Pulse tab (UX_SPEC §4.b): repo-scoped trend charts. Every chart carries its
// tableData so the "view as table" toggle works — NFR-5 treats a chart with no
// text equivalent as inaccessible, not merely unpolished.

interface Props {
  repoId: string;
  window: string;
}

function TrendChart({
  repoId,
  window,
  metric,
}: {
  repoId: string;
  window: string;
  metric: (typeof PULSE_METRICS)[number];
}) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: metric.key, window, repo_id: repoId },
  });

  const points = (data?.points ?? []).filter(
    (p): p is { computed_at: string; value: number } => p.value !== null,
  );
  const labels = points.map((p) => p.computed_at.slice(0, 10));
  const values = points.map((p) => Number(scaleForUnit(p.value, metric.unit).toFixed(2)));

  return (
    <WidgetFrame
      title={metric.label}
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && points.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No snapshots for this metric in this window."
    >
      <Chart
        testId={`trend-${metric.key}`}
        ariaLabel={`${metric.label} trend, last ${window}`}
        height={180}
        tableData={{
          columns: ['Date', metric.unit ? `${metric.label} (${metric.unit})` : metric.label],
          rows: labels.map((l, i) => [l, values[i] ?? 0]),
        }}
        option={{
          grid: { left: 44, right: 12, top: 16, bottom: 28 },
          xAxis: { type: 'category', data: labels },
          // W16-05 (F18). The axis showed bare numbers — "PR cycle time" ran to
          // 180 and "Review coverage" fell 50 → 10 with nothing saying hours or
          // per cent. The unit was known all along (REPO_METRICS carries it,
          // and the table fallback already used it); it just never reached the
          // axis. The KPI tiles got this right, which made the charts the odd
          // ones out on the same screen.
          yAxis: {
            type: 'value',
            ...(metric.unit
              ? {
                  name: metric.unit,
                  // Above the axis rather than rotated alongside it: one or two
                  // characters read better there, and it cannot collide with
                  // the tick labels.
                  nameLocation: 'end' as const,
                  nameGap: 8,
                }
              : {}),
          },
          tooltip: { trigger: 'axis' },
          series: [{ type: 'line', smooth: true, showSymbol: false, data: values }],
        }}
      />
    </WidgetFrame>
  );
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
