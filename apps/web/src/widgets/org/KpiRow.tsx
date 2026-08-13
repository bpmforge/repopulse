import { KpiTile, Sparkline, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { KPI_TILES, formatKpi, type MetricSeries, type OrgSummary } from './contracts.js';

// UX_SPEC §4.a: five KPI tiles, each with a sparkline and a TrendDelta (KpiTile
// renders the delta from deltaPct + polarity).
//
// No click target here, deliberately. §4.a annotates "click →" on the health
// grid and the hotspot leaderboard only; the KPI tiles are specified as
// "value + delta + sparkline, max" (principle 2, progressive disclosure), and
// their evidence affordance is the definition link (FR-METRICS-15). Wrapping
// them in a Link would have meant inventing a /metrics/$key screen that no
// board ticket creates — a dead end, which principle 3 forbids more clearly
// than it demands a link here.

interface Props {
  window: string;
}

function KpiSparkline({
  metricKey,
  label,
  window,
}: {
  metricKey: string;
  label: string;
  window: string;
}) {
  const { data } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: metricKey, window },
  });
  const points = (data?.points ?? []).map((p) => p.value).filter((v): v is number => v !== null);
  // Below two points there is no line to draw — render nothing rather than a
  // flat stub, which reads as "no change" instead of "no history yet".
  if (points.length < 2) return null;
  return <Sparkline points={points} label={`${label}, last ${window}`} />;
}

export function KpiRow({ window }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSummary>({
    endpoint: '/org/summary',
    query: { window },
  });

  const byKey = new Map((data?.tiles ?? []).map((t) => [t.metric_key, t]));
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && data.tiles.length === 0,
  });

  return (
    <WidgetFrame
      title="Delivery KPIs"
      state={state}
      {...(error ? { errorMessage: error.message } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No metric snapshots yet for this window."
      definitionHref="/api/v1/metrics/catalog"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="kpi-row">
        {KPI_TILES.map((tile) => {
          const row = byKey.get(tile.key);
          return (
            <KpiTile
              key={tile.key}
              label={tile.label}
              value={formatKpi(row?.value ?? null, tile.unit)}
              {...(tile.unit ? { unit: tile.unit } : {})}
              deltaPct={row?.delta ?? null}
              polarity={tile.polarity}
              aside={<KpiSparkline metricKey={tile.key} label={tile.label} window={window} />}
            />
          );
        })}
      </div>
    </WidgetFrame>
  );
}
