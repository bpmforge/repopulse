import { createFileRoute, Link } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState } from '../components/index.js';
import { useApiQuery } from '../api/useApiQuery.js';
import type { HealthTiles } from '../widgets/org/contracts.js';

// The rail's "Pull Requests" destination.
//
// UX_SPEC §4.c also wants an ORG-WIDE PR list, but no endpoint returns one —
// the API exposes /repos/{id}/prs and /me/prs only (W4-16). Fanning out one
// request per repo from the browser would be an N+1 against the p95 <500ms
// budget and would silently degrade as repo count grows, so this lists repos
// and routes into each repo's PR list instead. A real screen, not a stub, and
// it does not pretend to be the org-wide list.
export const Route = createFileRoute('/pull-requests')({
  component: PullRequestsIndex,
});

function PullRequestsIndex() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data, isLoading, isError, error, refetch } = useApiQuery<HealthTiles>({
    endpoint: '/org/health-tiles',
    query: { window: search.window },
  });
  const items = data?.items ?? [];

  return (
    <WidgetFrame
      title="Pull requests by repository"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
      {...(error ? { errorMessage: error.message } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No repositories connected yet."
    >
      <ul className="flex flex-col gap-2" data-testid="pr-repo-picker">
        {items.map((repo) => (
          <li key={repo.id}>
            <Link
              to="/repos/$repoId/prs"
              params={{ repoId: String(repo.id) }}
              search={preserved as never}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="truncate">{repo.name}</span>
              <span className="text-xs text-fg-muted">View PRs →</span>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
