import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { docsUrl } from '../../lib/docs.js';
import type { MetricSeries, RepoCi } from './contracts.js';

// CI tab (UX_SPEC §4.b): pass-rate trend, run duration, and the flakiest
// workflows — M9's three components (METRICS.md §1).
//
// The empty state that stood here named W4-15, and the reason was real: M9's
// snapshot row carried a single `value`, because computeCiDuration and
// computeCiFlakiness were implemented, fixture-tested and called by NOBODY.
// W4-15 made the snapshot carry all three; this reads them.
//
// Pass rate is DEFAULT-BRANCH only, shown beside the PR-run rate rather than
// pooled with it: §1 reports them separately, and a repo with noisy PR CI has a
// different problem from one whose main branch is broken.

interface Props {
  repoId: string;
  window: string;
}

/** ms → a duration a human reads at a glance; null stays an em dash, not 0. */
function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function CiTrends({ repoId, window }: Props) {
  const {
    data: ci,
    isLoading: ciLoading,
    isError: ciIsError,
    error: ciError,
    refetch: refetchCi,
  } = useApiQuery<RepoCi>({
    endpoint: '/repos/{id}/ci',
    path: { id: repoId },
    query: { window },
  });

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
        {...(error ? { errorMessage: error.message, error } : {})}
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
            grid: { left: 44, right: 12, top: 30, bottom: 28 },
            xAxis: { type: 'category', data: labels },
            // W20-12 (UX_TODO DSH-28): the unit on the axis, as TrendChart does.
            yAxis: { type: 'value', max: 100, name: '%', nameLocation: 'end', nameGap: 8 },
            tooltip: { trigger: 'axis' },
            series: [{ type: 'line', smooth: true, showSymbol: false, data: values }],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="Run duration (default branch)"
        state={frameState({
          isLoading: ciLoading,
          isError: ciIsError,
          isEmpty: ci !== undefined && ci.duration?.medianMs == null,
        })}
        // W20-12 (UX_TODO DSH-29): the error itself, so a failure shows its
        // message and request id rather than "Something went wrong."
        {...(ciError ? { errorMessage: ciError.message, error: ciError } : {})}
        onRetry={() => void refetchCi()}
        emptyMessage={
          ci && !ci.components_available
            ? 'This repo has not been snapshotted since CI duration and flakiness began being recorded. It will fill in at the next nightly run.'
            : 'No completed runs with timings in this window.'
        }
      >
        {/* Two numbers, not a chart: duration is stored per snapshot as a
            median and p90, so a "trend" would need a series this endpoint does
            not return. A two-point line pretending to be a trend is the exact
            thing the old empty state existed to avoid. */}
        <dl className="flex gap-8" data-testid="ci-duration">
          <div>
            <dt className="text-xs text-fg-muted">Median</dt>
            <dd className="text-2xl tabular-nums">{formatMs(ci?.duration?.medianMs ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">p90</dt>
            <dd className="text-2xl tabular-nums">{formatMs(ci?.duration?.p90Ms ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Runs</dt>
            <dd className="text-2xl tabular-nums">{ci?.default_branch_runs ?? '—'}</dd>
          </div>
        </dl>
      </WidgetFrame>

      <WidgetFrame
        title="Flakiest workflows"
        state={frameState({
          isLoading: ciLoading,
          isError: ciIsError,
          isEmpty: ci !== undefined && (ci.flakiest?.length ?? 0) === 0,
        })}
        {...(ciError ? { errorMessage: ciError.message, error: ciError } : {})}
        onRetry={() => void refetchCi()}
        // W20-12 (UX_TODO DSH-16): through docsUrl — the bare path opened the
        // app's 404 page, since the app does not serve /docs.
        definitionHref={docsUrl('/docs/design/METRICS.md')}
        emptyMessage={
          ci && !ci.components_available
            ? 'This repo has not been snapshotted since flakiness began being recorded.'
            : 'No workflow was rerun on the same commit in this window — flakiness needs a rerun to measure.'
        }
      >
        {/* W20-12 (UX_TODO DSH-29): the columns in plain words. */}
        <p className="mb-2 text-xs text-fg-muted">
          A workflow is flaky when it failed and then passed on a rerun of the same commit.
          &ldquo;Commits rerun&rdquo; counts commits where it was rerun; &ldquo;Failed then
          passed&rdquo; counts the ones where the rerun changed the result.
        </p>
        {/* W21-01: at 768px and 200% zoom the four columns ran 2px past the
            page; the table scrolls in its own region and a long workflow name
            wraps. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Flakiest workflows">
          <table className="table-plain w-full text-sm" data-testid="ci-flakiest">
            <caption className="sr-only">
              Workflows ranked by fail-to-pass reruns on the same commit
            </caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Workflow</th>
                <th scope="col" className="text-right">
                  Failed then passed
                </th>
                <th scope="col" className="text-right">
                  Commits rerun
                </th>
                <th scope="col" className="text-right">
                  Flaky rate
                </th>
              </tr>
            </thead>
            <tbody>
              {(ci?.flakiest ?? []).map((f) => (
                <tr key={f.workflow} className="border-t border-border">
                  <th scope="row" className="py-1 text-left font-normal [overflow-wrap:anywhere]">
                    {f.runs_url ? (
                      <a
                        href={f.runs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent underline"
                        data-testid={`ci-flaky-runs-${f.workflow}`}
                      >
                        {f.workflow}
                        <span className="sr-only"> — open its runs on the forge (new tab)</span>
                      </a>
                    ) : (
                      f.workflow
                    )}
                  </th>
                  <td className="py-1 text-right tabular-nums">{f.flipped_groups}</td>
                  <td className="py-1 text-right tabular-nums">{f.rerun_groups}</td>
                  {/* null rate = never rerun, which is not a rate of 0. */}
                  <td className="py-1 text-right tabular-nums">
                    {f.flakiness === null ? '—' : `${Math.round(f.flakiness * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>
    </div>
  );
}
