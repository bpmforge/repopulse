import { useState } from 'react';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { AvailableRepos } from './contracts.js';

// Repo selection (UX_SPEC §4.i). Creating a connection only stores a
// credential — selecting repositories is what creates the repo rows, registers
// webhooks and enqueues the backfill plans. Without this the operator can
// connect and then has no way to start collecting, which is the difference
// between "connected" and "collecting".

interface Props {
  connectionId: number;
  /** Invalidated after selection so the connection's repo_count refreshes. */
  connectionsKey: readonly unknown[];
}

export function RepoPicker({ connectionId, connectionsKey }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const descriptor = {
    endpoint: '/connections/{id}/available-repos',
    path: { id: connectionId },
  } as const;
  const { data, isLoading, isError, error, refetch } = useApiQuery<AvailableRepos>(descriptor);

  const select = useApiMutation<{ repo_forge_ids: string[] }, { repo_ids: number[] }>(
    { endpoint: '/connections/{id}/repos', path: { id: connectionId } },
    { invalidate: [connectionsKey, queryKeyFor(descriptor)] },
  );

  const items = data?.items ?? [];

  return (
    <WidgetFrame
      title="Select repositories to track"
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && items.length === 0,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="This credential can see no repositories. Check its scopes, or that it has access to the organisation."
    >
      <div className="flex flex-col gap-3" data-testid="repo-picker">
        <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
          {items.map((repo) => {
            const id = repo.forge_repo_id;
            return (
              <li key={id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                    data-testid={`repo-option-${id}`}
                  />
                  <span className="truncate">
                    {repo.org}/{repo.name}
                  </span>
                  {repo.is_archived && <span className="text-xs text-fg-muted">archived</span>}
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={selected.size === 0 || select.isPending}
            onClick={() => select.mutate({ repo_forge_ids: [...selected] })}
            className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="repo-select-submit"
          >
            {select.isPending ? 'Starting backfill…' : `Track ${selected.size} repo(s)`}
          </button>
          {select.isSuccess && (
            <span className="text-xs text-fg-muted" data-testid="repo-select-result">
              Backfill queued for {select.data.repo_ids.length} repo(s) — history fills in as it
              lands.
            </span>
          )}
          {select.isError && (
            <span className="text-xs text-crit" role="alert" data-testid="repo-select-error">
              {select.error.message}
            </span>
          )}
        </div>
      </div>
    </WidgetFrame>
  );
}
