import { createFileRoute, Link } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { HealthBadge, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { HealthTiles } from '../../widgets/org/contracts.js';

// Repo list — the breadcrumb's middle rung. Org Overview links straight to a
// repo, but a pasted /repos URL has to land somewhere real rather than the
// not-found placeholder (FR-WEB-2, "no dead ends").
export const Route = createFileRoute('/repos/')({
  component: RepoList,
});

function RepoList() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data, isLoading, isError, error, refetch } = useApiQuery<HealthTiles>({
    endpoint: '/org/health-tiles',
    query: { window: search.window },
  });
  const items = data?.items ?? [];

  return (
    <WidgetFrame
      title="Repositories"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && items.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No repositories connected yet."
    >
      {/* W16-05 (F20). The badge carried a good aria-label all along, so a
          screen reader always heard "health score 39 of 100, needs attention" —
          but a sighted reader got a bare coloured number with no header and no
          legend anywhere on the screen. The repo page pairs the same number with
          a "why?" link and a "4 not measured" caveat; the list dropped both. */}
      <div className="flex items-center justify-between px-3 pb-1 text-xs text-fg-muted">
        <span>Repository</span>
        <span>Health score (0–100)</span>
      </div>

      <ul className="flex flex-col gap-2" data-testid="repo-list">
        {items.map((repo) => (
          <li key={repo.id}>
            <Link
              to="/repos/$repoId"
              params={{ repoId: String(repo.id) }}
              search={preserved as never}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="truncate">{repo.name}</span>
              <HealthBadge score={repo.health.score} />
            </Link>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
