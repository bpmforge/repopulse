import { Link } from '@tanstack/react-router';
import { KpiTile, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  DELIVERY_METRICS,
  UNCOMPUTED_DORA,
  latestValue,
  type MetricSeries,
  type RepoCi,
} from './contracts.js';
import { TrendChart } from './TrendChart.js';

// Performance tab (W17-19): "how fast does work get out of this repository".
//
// It owns no endpoint. Release cadence and deployment frequency (M11, M12) are
// metric series nothing else on the repo screen shows; the CI turnaround
// numbers already live on the CI tab and are REPEATED here as tiles because a
// performance question that omits build time answers half of itself. The tile
// links to the CI tab rather than re-rendering its charts.
//
// The DORA components v1 does not compute are listed, not omitted: a panel
// that shows only the measured quarter of DORA reads as a clean bill of health
// (the unmeasured-passes-for-measured defect W17-18 removed from scoring).

interface Props {
  repoId: string;
  window: string;
  search: Record<string, string>;
}

/** ms → a duration a human reads at a glance; null stays an em dash, not 0. */
function formatMs(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function DeliveryTile({
  repoId,
  window,
  metric,
}: {
  repoId: string;
  window: string;
  metric: (typeof DELIVERY_METRICS)[number];
}) {
  const { data } = useApiQuery<MetricSeries>({
    endpoint: '/metrics/series',
    query: { metric_key: metric.key, window, repo_id: repoId },
  });
  const latest = latestValue(data);
  return (
    <KpiTile
      label={metric.label}
      value={latest === null ? null : String(Number(latest.toFixed(1)))}
      unit={metric.unit}
      aside={
        // The basis label (METRICS.md §1) says what was counted — releases,
        // tags, deployments — because Gitea has no deployments API and the
        // number means something different per forge.
        data?.basis_label ? (
          <span className="text-xs text-fg-faint" data-testid={`basis-${metric.key}`}>
            basis: {data.basis_label}
          </span>
        ) : null
      }
    />
  );
}

export function RepoPerformance({ repoId, window, search }: Props) {
  const {
    data: ci,
    isLoading,
    isError,
    error,
    refetch,
  } = useApiQuery<RepoCi>({
    endpoint: '/repos/{id}/ci',
    path: { id: repoId },
    query: { window },
  });

  const passRate = ci?.pass_rate ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="repo-performance">
      <WidgetFrame
        title="Delivery cadence"
        state="ready"
        definitionHref="/api/v1/metrics/catalog"
        drillDown={
          <Link
            to="/repos/$repoId/"
            params={{ repoId }}
            search={search as never}
            className="text-xs text-accent underline-offset-2 hover:underline"
            data-testid="performance-to-pulse"
          >
            Cycle time and throughput →
          </Link>
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="delivery-tiles">
          {DELIVERY_METRICS.map((metric) => (
            <DeliveryTile key={metric.key} repoId={repoId} window={window} metric={metric} />
          ))}
          <KpiTile
            label="CI pass rate (default branch)"
            value={passRate === null ? null : (passRate * 100).toFixed(0)}
            unit="%"
            aside={
              <Link
                to="/repos/$repoId/ci"
                params={{ repoId }}
                search={search as never}
                className="text-xs text-accent underline-offset-2 hover:underline"
                data-testid="performance-to-ci"
              >
                CI →
              </Link>
            }
          />
          <KpiTile
            label="CI run duration (median)"
            value={formatMs(ci?.duration?.medianMs ?? null)}
            polarity="down-good"
          />
        </div>
        {isError && (
          <p
            className="mt-2 text-xs text-fg-muted"
            role="status"
            data-testid="performance-ci-error"
          >
            CI numbers unavailable: {error?.message ?? 'the request failed.'}{' '}
            <button
              type="button"
              className="text-accent underline-offset-2 hover:underline"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        )}
        {isLoading && <span className="sr-only">Loading CI numbers</span>}
      </WidgetFrame>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {DELIVERY_METRICS.map((metric) => (
          <TrendChart key={metric.key} repoId={repoId} window={window} metric={metric} />
        ))}
      </div>

      <WidgetFrame
        title="Not computed in v1"
        state={frameState({ isLoading: false, isError: false, isEmpty: false })}
        testId="uncomputed-dora"
      >
        <p className="mb-2 text-sm text-fg-muted">
          These DORA measures need deployment and incident data this version does not ingest. They
          are listed so their absence is not mistaken for a good score.
        </p>
        <ul className="flex flex-wrap gap-2 text-sm">
          {UNCOMPUTED_DORA.map((name) => (
            <li key={name} className="rounded-full border border-border px-2 py-0.5 text-fg-muted">
              {name}
            </li>
          ))}
        </ul>
      </WidgetFrame>
    </div>
  );
}
