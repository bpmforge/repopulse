import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  ACTIVITY_LIMIT,
  type RepoCi,
  type RepoHotspots as RepoHotspotsResponse,
  type RepoPrs,
} from './contracts.js';

// Activity tab (W17-19): "what has been happening here", answered by composing
// the analyses that already exist — the PR list, CI, hotspots and PR flow —
// and LINKING to each. It is not a new historical event API and must not grow
// into one: every number below comes from an endpoint another tab already
// reads, so the two can never disagree.

interface Props {
  repoId: string;
  window: string;
  search: Record<string, string>;
}

function SeeAll({
  to,
  repoId,
  search,
  testId,
  children,
}: {
  to: string;
  repoId: string;
  search: Record<string, string>;
  testId: string;
  children: string;
}) {
  return (
    <Link
      to={to as never}
      params={{ repoId } as never}
      search={search as never}
      className="text-xs text-accent underline-offset-2 hover:underline"
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

function RecentPrs({ repoId, window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoPrs>({
    endpoint: '/repos/{id}/prs',
    path: { id: repoId },
    query: { window },
  });
  // The API orders by updated_at desc, so the head of the list IS the most
  // recent activity; no client-side sort to drift from the PR list's own.
  const items = (data?.items ?? []).slice(0, ACTIVITY_LIMIT);
  return (
    <WidgetFrame
      title="Recent pull requests"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No pull requests opened in this window."
      testId="activity-prs"
      drillDown={
        <SeeAll to="/repos/$repoId/prs" repoId={repoId} search={search} testId="activity-to-prs">
          All pull requests →
        </SeeAll>
      }
    >
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((pr) => (
          <li key={pr.number} className="flex items-baseline gap-2">
            <Link
              to="/repos/$repoId/prs/$number"
              params={{ repoId, number: String(pr.number) }}
              search={search as never}
              className="text-accent underline-offset-2 hover:underline"
            >
              #{pr.number}
            </Link>
            <span className="truncate">{pr.title}</span>
            <span className="ml-auto shrink-0 text-xs text-fg-muted">
              {pr.state} · {pr.size_bucket}
              {pr.review_covered ? '' : ' · unreviewed'}
            </span>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

function CiNow({ repoId, window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoCi>({
    endpoint: '/repos/{id}/ci',
    path: { id: repoId },
    query: { window },
  });
  const flakiest = data?.flakiest[0];
  return (
    <WidgetFrame
      title="CI"
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && data.default_branch_runs === null && data.pr_runs === null,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No CI runs in this window."
      testId="activity-ci"
      drillDown={
        <SeeAll to="/repos/$repoId/ci" repoId={repoId} search={search} testId="activity-to-ci">
          Trends and flakiness →
        </SeeAll>
      }
    >
      <dl className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-xs text-fg-muted">Default-branch pass rate</dt>
          <dd className="tabular-nums">
            {data?.pass_rate == null ? '—' : `${(data.pass_rate * 100).toFixed(0)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Runs</dt>
          <dd className="tabular-nums">
            {data?.default_branch_runs ?? '—'} main · {data?.pr_runs ?? '—'} PR
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Flakiest workflow</dt>
          {/* null flakiness = never rerun, which is not a flakiness of 0. */}
          <dd className="truncate">
            {flakiest
              ? `${flakiest.workflow}${flakiest.flakiness === null ? '' : ` (${(flakiest.flakiness * 100).toFixed(0)}%)`}`
              : '—'}
          </dd>
        </div>
      </dl>
    </WidgetFrame>
  );
}

function HotFiles({ repoId, window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoHotspotsResponse>({
    endpoint: '/repos/{id}/hotspots',
    path: { id: repoId },
    query: { window },
  });
  const items = (data?.items ?? []).slice(0, ACTIVITY_LIMIT);
  return (
    <WidgetFrame
      title="Files changing most"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No churn recorded in this window."
      testId="activity-hotspots"
      drillDown={
        <SeeAll
          to="/repos/$repoId/hotspots"
          repoId={repoId}
          search={search}
          testId="activity-to-hotspots"
        >
          Treemap and scores →
        </SeeAll>
      }
    >
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((h) => (
          <li key={h.path} className="flex items-baseline gap-2">
            <Link
              to="/repos/$repoId/files/$"
              params={{ repoId, _splat: h.path } as never}
              search={search as never}
              className="truncate font-mono text-xs text-accent underline-offset-2 hover:underline"
            >
              {h.path}
            </Link>
            <span className="ml-auto shrink-0 tabular-nums text-xs text-fg-muted">
              {h.hotspot_score.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

export function RepoActivity(props: Props) {
  return (
    <div className="flex flex-col gap-4" data-testid="repo-activity">
      <RecentPrs {...props} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CiNow {...props} />
        <HotFiles {...props} />
      </div>
      <p className="text-sm text-fg-muted">
        How these pull requests moved from open to merged is on{' '}
        <SeeAll
          to="/repos/$repoId/pr-flow"
          repoId={props.repoId}
          search={props.search}
          testId="activity-to-pr-flow"
        >
          PR Flow →
        </SeeAll>
      </p>
    </div>
  );
}
