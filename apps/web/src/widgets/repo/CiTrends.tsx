import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { MetricSeries } from './contracts.js';

// CI tab (UX_SPEC §4.b): pass-rate trend from M9 snapshots.
//
// NOT built here: duration trend and flaky ranking. M9's snapshot row carries a
// single `value` (pass rate); duration and flakiness are separate components of
// the metric that no endpoint currently returns, and there is no flaky-run
// ranking endpoint at all (see W4-15). A "flaky tests" panel fed by anything
// else would be invented data on a screen whose whole job is evidence.

interface Props {
  repoId: string;
  window: string;
}

export function CiTrends({ repoId, window }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: 'M9', window, repo_id: repoId },
  });

  const points = (data?.points ?? []).filter(
    (p): p is { computed_at: string; value: number } => p.value !== null,
  );
  const labels = points.map((p) => p.computed_at.slice(0, 10));
  // M9 is stored 0..1; a CI pass rate axis that reads 0-1 instead of 0-100%
  // invites exactly the misreading W4-13 caught on the KPI tiles.
  const values = points.map((p) => Number((p.value * 100).toFixed(1)));

  return (
    <div className="flex flex-col gap-4" data-testid="repo-ci">
      <WidgetFrame
        title="CI pass rate"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && points.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No CI snapshots in this window."
      >
        <Chart
          testId="ci-pass-rate"
          ariaLabel={`CI pass rate trend, last ${window}`}
          height={220}
          tableData={{
            columns: ['Date', 'Pass rate (%)'],
            rows: labels.map((l, i) => [l, values[i] ?? 0]),
          }}
          option={{
            grid: { left: 44, right: 12, top: 16, bottom: 28 },
            xAxis: { type: 'category', data: labels },
            yAxis: { type: 'value', max: 100 },
            tooltip: { trigger: 'axis' },
            series: [{ type: 'line', smooth: true, showSymbol: false, data: values }],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="Duration & flaky ranking"
        state="empty"
        emptyMessage="Needs an API that reports M9's duration and flakiness components and a flaky-run ranking — tracked as W4-15. Left empty rather than filled with a proxy."
      />
    </div>
  );
}
