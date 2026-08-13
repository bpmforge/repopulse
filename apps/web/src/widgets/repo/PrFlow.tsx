import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { SIZE_BUCKETS, type RepoPrs } from './contracts.js';

// PR Flow tab (UX_SPEC §4.b, FR-WEB-3): the open→reviewed→merged funnel and the
// XS–XL size histogram, both derived from the PR list rather than a bespoke
// endpoint — the list already carries state, review_covered and size_bucket.
//
// NOT built here: the review-load matrix, which needs per-reviewer counts the
// API does not expose (see W4-15). Shipping a matrix off author data would put
// a plausible-looking chart on screen that answers a different question, which
// is worse than the tab not having it yet.

interface Props {
  repoId: string;
  window: string;
}

export function PrFlow({ repoId, window }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoPrs>({
    endpoint: '/repos/{id}/prs',
    path: { id: repoId },
    query: { window },
  });

  const items = data?.items ?? [];
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && items.length === 0,
  });

  // Funnel stages are cumulative and must be monotonically non-increasing, so
  // each stage counts PRs that reached AT LEAST that far.
  const opened = items.length;
  const reviewed = items.filter((p) => p.review_covered).length;
  const merged = items.filter((p) => p.state === 'merged').length;
  const funnel = [
    { name: 'Opened', value: opened },
    { name: 'Reviewed', value: reviewed },
    { name: 'Merged', value: merged },
  ];

  const sizeCounts = SIZE_BUCKETS.map(
    (bucket) => items.filter((p) => p.size_bucket === bucket).length,
  );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="repo-pr-flow">
      <WidgetFrame
        title="PR funnel"
        state={state}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No pull requests in this window."
      >
        <Chart
          testId="pr-funnel"
          ariaLabel={`Pull request funnel, last ${window}`}
          height={220}
          tableData={{ columns: ['Stage', 'PRs'], rows: funnel.map((f) => [f.name, f.value]) }}
          option={{
            tooltip: { trigger: 'item' },
            series: [{ type: 'funnel', sort: 'none', data: funnel, min: 0, max: opened || 1 }],
          }}
        />
      </WidgetFrame>

      <WidgetFrame
        title="PR size distribution"
        state={state}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No pull requests in this window."
      >
        <Chart
          testId="pr-size-histogram"
          ariaLabel={`Pull request size distribution, last ${window}`}
          height={220}
          tableData={{
            columns: ['Size', 'PRs'],
            rows: SIZE_BUCKETS.map((b, i) => [b, sizeCounts[i] ?? 0]),
          }}
          option={{
            grid: { left: 40, right: 12, top: 16, bottom: 28 },
            // Buckets in METRICS.md M7 order, never alphabetical — a size axis
            // reading L, M, S, XL, XS is actively misleading.
            xAxis: { type: 'category', data: [...SIZE_BUCKETS] },
            yAxis: { type: 'value', minInterval: 1 },
            tooltip: { trigger: 'axis' },
            series: [{ type: 'bar', data: sizeCounts }],
          }}
        />
      </WidgetFrame>
    </div>
  );
}
