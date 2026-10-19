import { KpiTile, Sparkline, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { docsUrl } from '../../lib/docs.js';
import { withRepos } from '../scopeRepos.js';
import {
  KPI_TILES,
  SMALL_SAMPLE,
  deltaOf,
  formatKpi,
  type MetricSeries,
  type OrgSummary,
} from './contracts.js';

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
  /** A repository csv (DSH-02), or absent for the whole workspace. */
  repos?: string | undefined;
  /** Frame title; the repo Pulse tab names its own (DSH-12). */
  title?: string;
}

function KpiSparkline({
  metricKey,
  label,
  window,
  repoId,
  now,
}: {
  metricKey: string;
  label: string;
  window: string;
  repoId?: string | undefined;
  /** The tile's current value, for the label (W20-12, UX_TODO DSH-55). */
  now: string | null;
}) {
  const { data } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: metricKey, window, ...(repoId ? { repo_id: repoId } : {}) },
  });
  const points = (data?.points ?? []).map((p) => p.value).filter((v): v is number => v !== null);
  // Below two points there is no line to draw — render nothing rather than a
  // flat stub, which reads as "no change" instead of "no history yet".
  if (points.length < 2) return null;
  // Says what the line IS (W20-12, DSH-75): each point is that night's
  // rolling-window value, and the series spans one window.
  return (
    <Sparkline
      points={points}
      label={`${label}, rolling ${window} value by night over the last ${window}${now === null ? '' : `, now ${now}`}`}
    />
  );
}

export function KpiRow({ window, repos, title = 'Delivery KPIs' }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSummary>({
    endpoint: '/org/summary',
    query: withRepos({ window }, repos),
  });
  // A sparkline is one series: the org rollup, or ONE repository's. A set of
  // several has no stored series, so its tiles carry the value and delta only
  // rather than a line that would describe the whole workspace (DSH-02).
  const single = repos && !repos.includes(',') ? repos : undefined;

  const byKey = new Map((data?.tiles ?? []).map((t) => [t.metric_key, t]));
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && data.tiles.length === 0,
  });

  return (
    <WidgetFrame
      title={title}
      state={state}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No metric snapshots yet for this window."
      // W20-12 (UX_TODO DSH-15): the rendered definitions page, not the raw
      // JSON catalog endpoint.
      definitionHref={docsUrl('/docs/design/METRICS.md')}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="kpi-row">
        {KPI_TILES.map((tile) => {
          const row = byKey.get(tile.key);
          const value = formatKpi(row?.value ?? null, tile.unit);
          const delta = deltaOf(row?.delta ?? null, row?.previous ?? null, tile.unit);
          const sample = row?.sample ?? null;
          return (
            <KpiTile
              key={tile.key}
              label={tile.label}
              value={value}
              {...(tile.unit ? { unit: tile.unit } : {})}
              deltaPct={delta.value}
              deltaKind={delta.kind}
              polarity={tile.polarity}
              caption={
                // W20-12 (UX_TODO DSH-81): what the ratio rests on. "100%" from
                // one merged PR looked exactly as solid as 100% from 400.
                sample && value !== null ? (
                  <span className="text-xs text-fg-faint" data-testid={`kpi-sample-${tile.key}`}>
                    {sample.numerator} of {sample.denominator}
                    {sample.denominator < SMALL_SAMPLE ? ' · small sample' : ''}
                  </span>
                ) : undefined
              }
              aside={
                repos && !single ? undefined : (
                  <KpiSparkline
                    metricKey={tile.key}
                    label={tile.label}
                    window={window}
                    repoId={single}
                    now={value === null ? null : `${value}${tile.unit ? ` ${tile.unit}` : ''}`}
                  />
                )
              }
            />
          );
        })}
      </div>
    </WidgetFrame>
  );
}
