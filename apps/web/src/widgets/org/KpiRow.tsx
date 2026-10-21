import { EvidenceLink } from './EvidenceLink.js';
import { KpiTile, Sparkline, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { docsUrl } from '../../lib/docs.js';
import { withRepos } from '../scopeRepos.js';
import {
  KPI_TILES,
  SMALL_SAMPLE,
  changeText,
  deltaOf,
  formatKpi,
  type MetricSeries,
  type OrgSummary,
} from './contracts.js';
import { metricEvidence } from './metricLinks.js';

// UX_SPEC §4.a: five KPI tiles, each with a sparkline and a TrendDelta (KpiTile
// renders the delta from deltaPct + polarity).
//
// W20-20 (UX_TODO DSH-18): each tile links to its evidence — the list whose
// rows add up to the number (unreviewed merged PRs for review coverage), or
// the repository tab that charts it. Issue throughput has no such screen yet
// and gets no link rather than a link to somewhere unrelated.

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
  change,
}: {
  metricKey: string;
  label: string;
  window: string;
  repoId?: string | undefined;
  /** The tile's current value, for the label (W20-12, UX_TODO DSH-55). */
  now: string | null;
  /** The tile's change in words, for the label (W20-20, UX_TODO DSH-55). */
  change: string | null;
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
      label={`${label}, rolling ${window} value by night over the last ${window}${now === null ? '' : `, now ${now}`}${change === null ? '' : `, ${change} on the window before`}`}
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
  // W20-20 (UX_TODO DSH-56): a custom range is computed live for exactly its
  // days, but the nightly series behind the sparkline is per preset — a line
  // ending today under numbers for last month would contradict them.
  const range = data?.range;
  const custom = window.includes('..');

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
          const evidence = metricEvidence(tile.key, repos);
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
                <>
                  {/* W20-12 (UX_TODO DSH-81): what the ratio rests on. "100%"
                      from one merged PR looked as solid as 100% from 400. */}
                  {sample && value !== null && (
                    <span className="text-xs text-fg-faint" data-testid={`kpi-sample-${tile.key}`}>
                      {sample.numerator} of {sample.denominator}
                      {sample.denominator < SMALL_SAMPLE ? ' · small sample' : ''}
                    </span>
                  )}
                  {evidence && (
                    <EvidenceLink
                      evidence={evidence}
                      className="text-xs text-accent underline-offset-2 hover:underline"
                      testId={`kpi-evidence-${tile.key}`}
                    >
                      See {evidence.label}
                    </EvidenceLink>
                  )}
                </>
              }
              aside={
                (repos && !single) || custom ? undefined : (
                  <KpiSparkline
                    metricKey={tile.key}
                    label={tile.label}
                    window={window}
                    repoId={single}
                    now={value === null ? null : `${value}${tile.unit ? ` ${tile.unit}` : ''}`}
                    change={changeText(delta)}
                  />
                )
              }
            />
          );
        })}
      </div>
      {range && (
        <p className="mt-2 text-xs text-fg-muted" data-testid="kpi-range-note">
          Computed for {range.from} to {range.to} ({range.days} days); changes compare with the{' '}
          {range.days} days before.
        </p>
      )}
    </WidgetFrame>
  );
}
