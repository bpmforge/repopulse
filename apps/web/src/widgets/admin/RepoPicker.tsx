import { useState } from 'react';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { errorDetailOf } from '../../api/client.js';
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

/** What a tracked repo's stored status reads as next to its name (W20-07, INS-10). */
export function trackedLabel(syncStatus: string | null | undefined): string {
  switch (syncStatus) {
    case 'paused':
      return 'tracked · paused';
    case 'pending_backfill':
      return 'tracked · queued';
    case 'backfilling':
      return 'tracked · backfilling';
    case 'error':
      return 'tracked · error';
    case 'paused_budget':
      return 'tracked · waiting for rate limit';
    default:
      return 'tracked';
  }
}

export function RepoPicker({ connectionId, connectionsKey }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const descriptor = {
    endpoint: '/connections/{id}/available-repos',
    path: { id: connectionId },
  } as const;
  const { data, isLoading, isError, error, refetch } = useApiQuery<AvailableRepos>(descriptor);

  const select = useApiMutation<
    { repo_forge_ids: string[] } | { all_with_auto_add: true },
    { repo_ids: number[] }
  >(
    { endpoint: '/connections/{id}/repos', path: { id: connectionId } },
    { invalidate: [connectionsKey, queryKeyFor(descriptor)] },
  );

  const items = data?.items ?? [];
  // W20-07 (UX_TODO INS-10): tracked repos are shown ticked and disabled with
  // their state. The list used to look the same every time, so an admin could
  // not tell what they had already picked.
  const untracked = items.filter((r) => !r.tracked);
  const trackedCount = items.length - untracked.length;

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
      <div
        className="flex flex-col gap-3"
        data-testid="repo-picker"
        data-connection-id={connectionId}
      >
        {/* W20-07 (UX_TODO INS-52): the count makes a short list visible. The
            picker used to offer only the forge's first page — 100 on GitHub,
            50 on Gitea — and nothing said the rest existed. */}
        <p className="text-xs text-fg-muted" data-testid="repo-picker-count">
          {data?.total ?? items.length} repositories visible to this token
          {trackedCount > 0 ? ` · ${trackedCount} already tracked` : ''}
          {data?.truncated ? ' · the forge kept paging, so this list stops at a safety cap' : ''}
        </p>
        <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
          {items.map((repo) => {
            const id = repo.forge_repo_id;
            const tracked = repo.tracked === true;
            return (
              <li key={id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={tracked || selected.has(id)}
                    disabled={tracked}
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
                  <span className={`truncate ${tracked ? 'text-fg-muted' : ''}`}>
                    {repo.org}/{repo.name}
                  </span>
                  {tracked && (
                    <span className="text-xs text-fg-muted" data-testid={`repo-tracked-${id}`}>
                      {trackedLabel(repo.sync_status)}
                    </span>
                  )}
                  {repo.is_archived && <span className="text-xs text-fg-muted">archived</span>}
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={selected.size === 0 || select.isPending}
            onClick={() =>
              select.mutate(
                { repo_forge_ids: [...selected] },
                { onSuccess: () => setSelected(new Set()) },
              )
            }
            className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="repo-select-submit"
          >
            {select.isPending ? 'Starting backfill…' : `Track ${selected.size} repo(s)`}
          </button>
          {/* W20-07 (UX_TODO INS-09): the API always accepted "all"; the
              screen never offered it. It tracks every repository the token can
              see NOW. New repositories created later are not added on their
              own yet — pick them here when they appear. */}
          {untracked.length > 0 && (
            <button
              type="button"
              disabled={select.isPending}
              onClick={() =>
                select.mutate(
                  { all_with_auto_add: true },
                  { onSuccess: () => setSelected(new Set()) },
                )
              }
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
              data-testid="repo-select-all"
            >
              Track all {untracked.length} untracked
            </button>
          )}
          {select.isSuccess && (
            <span className="text-xs text-fg-muted" data-testid="repo-select-result">
              Backfill queued for {select.data.repo_ids.length} repo(s) — history fills in as it
              lands.
            </span>
          )}
          {select.isError && (
            <span className="text-xs text-crit" role="alert" data-testid="repo-select-error">
              {select.error.message}
              {errorDetailOf(select.error) ? ` — ${errorDetailOf(select.error)}` : ''}
            </span>
          )}
        </div>
      </div>
    </WidgetFrame>
  );
}
