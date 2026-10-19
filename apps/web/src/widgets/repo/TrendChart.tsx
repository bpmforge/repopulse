import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { scaleForUnit, type MetricSeries } from './contracts.js';

// One repo-scoped metric trend (UX_SPEC §4.b). Lived inside RepoPulse until
// W17-19 needed the same chart on the Performance tab; extracted rather than
// copied so the axis-unit and glyph-clipping fixes below stay in one place.
//
// Every chart carries its tableData so the "view as table" toggle works —
// NFR-5 treats a chart with no text equivalent as inaccessible, not merely
// unpolished.

export interface TrendMetric {
  key: string;
  label: string;
  unit: string;
}

export function TrendChart({
  repoId,
  window,
  metric,
}: {
  repoId: string;
  window: string;
  metric: TrendMetric;
}) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: metric.key, window, repo_id: repoId },
  });

  const points = (data?.points ?? []).filter(
    (p): p is typeof p & { value: number } => p.value !== null,
  );
  const labels = points.map((p) => p.computed_at.slice(0, 10));
  const values = points.map((p) => Number(scaleForUnit(p.value, metric.unit).toFixed(2)));
  // W20-12 (UX_TODO DSH-81): a ratio's parts, so the tooltip and the table
  // say what each point rests on ("40% — 4 of 10"). Absent for non-ratios.
  const samples = points.map((p) =>
    p.numerator != null && p.denominator != null ? `${p.numerator} of ${p.denominator}` : null,
  );
  const hasSamples = samples.some((x) => x !== null);

  return (
    <WidgetFrame
      title={metric.label}
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && points.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No snapshots for this metric in this window."
    >
      {/* W20-12 (UX_TODO DSH-75): what a point IS. The series now spans the
          selected window, and each point is that night's rolling value. */}
      <p className="mb-1 text-xs text-fg-faint" data-testid={`trend-caption-${metric.key}`}>
        Rolling {window} value, computed nightly — last {window}.
      </p>
      <Chart
        testId={`trend-${metric.key}`}
        ariaLabel={`${metric.label}, rolling ${window} value by night over the last ${window}`}
        height={180}
        tableData={{
          columns: [
            'Date',
            metric.unit ? `${metric.label} (${metric.unit})` : metric.label,
            ...(hasSamples ? ['Based on'] : []),
          ],
          rows: labels.map((l, i) => [
            l,
            values[i] ?? 0,
            ...(hasSamples ? [samples[i] ?? '—'] : []),
          ]),
        }}
        option={{
          // `top` LEAVES ROOM FOR THE UNIT (W16-42). At 16 the axis name sat
          // 8px above the axis end and its ascender fell outside the chart, so
          // the "h" on PR cycle time rendered as "n" — a clipped glyph that
          // reads as a different unit rather than as a rendering fault. Only
          // widened when there is a name to clip.
          grid: { left: 44, right: 12, top: metric.unit ? 30 : 16, bottom: 28 },
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
          tooltip: {
            trigger: 'axis',
            ...(hasSamples
              ? {
                  formatter: (params: unknown) => {
                    const first = (Array.isArray(params) ? params[0] : params) as {
                      dataIndex: number;
                      axisValue: string;
                      value: number;
                    };
                    const sample = samples[first.dataIndex];
                    return `${first.axisValue}<br/>${first.value}${metric.unit ? ` ${metric.unit}` : ''}${sample ? ` — ${sample}` : ''}`;
                  },
                }
              : {}),
          },
          series: [{ type: 'line', smooth: true, showSymbol: false, data: values }],
        }}
      />
    </WidgetFrame>
  );
}
