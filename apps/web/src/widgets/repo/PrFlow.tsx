import { Chart, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { SIZE_BUCKETS, type RepoPrs, type RepoReviewLoad } from './contracts.js';

// PR Flow tab (UX_SPEC §4.b, FR-WEB-3): the open→reviewed→merged funnel and the
// XS–XL size histogram, both derived from the PR list rather than a bespoke
// endpoint — the list already carries state, review_covered and size_bucket.
//
// The review-load matrix reads /repos/{id}/review-load, which counts REVIEWERS.
// It was left out until W4-15 because the PR list carries author and a
// review_covered flag and nothing else — a matrix built from those would have
// rendered plausibly while answering a different question, which is worse on
// this screen than not having it.
//
// It is workload distribution, not a leaderboard (UX_SPEC §7: signals, not
// grades). Self-reviews and bots are excluded by the API and the exclusions are
// stated on screen rather than quietly folded in.

interface Props {
  repoId: string;
  window: string;
}

export function PrFlow({ repoId, window }: Props) {
  const {
    data: load,
    isLoading: loadLoading,
    isError: loadIsError,
    refetch: refetchLoad,
  } = useApiQuery<RepoReviewLoad>({
    endpoint: '/repos/{id}/review-load',
    path: { id: repoId },
    query: { window },
  });

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

      <WidgetFrame
        title="Review load"
        state={frameState({
          isLoading: loadLoading,
          isError: loadIsError,
          isEmpty: load !== undefined && load.items.length === 0,
        })}
        onRetry={() => void refetchLoad()}
        emptyMessage="No reviews by another person in this window."
      >
        <div className="flex flex-col gap-2" data-testid="review-load">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Reviews per reviewer in the last {window}, excluding self-reviews and bots
            </caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Reviewer</th>
                <th scope="col" className="text-right">
                  PRs
                </th>
                <th scope="col" className="text-right">
                  Approved
                </th>
                <th scope="col" className="text-right">
                  Changes
                </th>
                <th scope="col" className="text-right">
                  Comments
                </th>
              </tr>
            </thead>
            <tbody>
              {(load?.items ?? []).map((r) => (
                <tr key={r.login} className="border-t border-border">
                  <th scope="row" className="py-1 text-left font-normal">
                    {r.login}
                  </th>
                  {/* PRs reviewed, not review events: four passes over one PR
                      is one PR's worth of load. */}
                  <td className="py-1 text-right tabular-nums">{r.prs_reviewed}</td>
                  <td className="py-1 text-right tabular-nums">{r.approvals}</td>
                  <td className="py-1 text-right tabular-nums">{r.changes_requested}</td>
                  <td className="py-1 text-right tabular-nums">{r.comments}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* State the exclusions rather than presenting a filtered number as a
              total — a reader who cannot see what was removed cannot judge it. */}
          <p className="text-xs text-fg-muted">
            {load?.prs_with_review ?? 0} PRs reviewed by someone other than their author. Excludes{' '}
            {load?.excluded.self_reviews ?? 0} self-review(s) and {load?.excluded.bot_reviews ?? 0}{' '}
            bot review(s). Workload distribution, not a ranking of people.
          </p>
        </div>
      </WidgetFrame>
    </div>
  );
}
