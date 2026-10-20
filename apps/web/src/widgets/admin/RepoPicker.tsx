import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
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
  /**
   * Which forge and host this picker lists, e.g. "GitHub · github.com"
   * (W20-14, UX_TODO INS-28): with several connections every picker had the
   * same title and nothing said which forge it was.
   */
  sourceLabel?: string;
  /** Move focus to the picker when it opens (W20-14, INS-27: right after a connect). */
  autoFocus?: boolean;
}

/** "1 repository" / "3 repositories" (W20-14, UX_TODO INS-44). */
export function repoCount(n: number): string {
  return `${n} ${n === 1 ? 'repository' : 'repositories'}`;
}

/** What a tracked repo's stored status reads as next to its name (W20-07, INS-10). */
export function trackedLabel(syncStatus: string | null | undefined): string {
  switch (syncStatus) {
    case 'paused':
      return 'tracked · paused';
    case 'pending_backfill':
      return 'tracked · queued';
    case 'backfilling':
      return 'tracked · loading history';
    case 'error':
      return 'tracked · error';
    case 'paused_budget':
      return 'tracked · waiting for rate limit';
    default:
      return 'tracked';
  }
}

/** Case-insensitive match on `org/name` (W20-14, UX_TODO INS-28). */
export function matchesFilter(repo: { org: string; name: string }, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  return q === '' || `${repo.org}/${repo.name}`.toLowerCase().includes(q);
}

export function RepoPicker({ connectionId, connectionsKey, sourceLabel, autoFocus }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const descriptor = {
    endpoint: '/connections/{id}/available-repos',
    path: { id: connectionId },
  } as const;
  const { data, isLoading, isError, error, refetch } = useApiQuery<AvailableRepos>(descriptor);

  const select = useApiMutation<
    { repo_forge_ids: string[] } | { all_with_auto_add: true },
    { repo_ids: number[]; webhook_failed?: string[] }
  >(
    { endpoint: '/connections/{id}/repos', path: { id: connectionId } },
    { invalidate: [connectionsKey, queryKeyFor(descriptor)] },
  );

  // INS-27: after a connect this panel is the required next step, so focus
  // moves here instead of staying on the Connect button.
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);

  const items = data?.items ?? [];
  // W20-07 (UX_TODO INS-10): tracked repos are shown ticked and disabled with
  // their state. The list used to look the same every time, so an admin could
  // not tell what they had already picked.
  const untracked = items.filter((r) => !r.tracked);
  const trackedCount = items.length - untracked.length;
  const shown = items.filter((r) => matchesFilter(r, filter));
  const failed = select.data?.webhook_failed ?? [];

  return (
    // The focus target wraps the frame, so it exists in the loading, empty and
    // error states too, not only once a list has arrived.
    <div
      ref={rootRef}
      tabIndex={-1}
      className="focus:outline-none"
      data-testid="repo-picker-panel"
      aria-label={sourceLabel ? `Choose repositories on ${sourceLabel}` : 'Choose repositories'}
      role="region"
    >
      <WidgetFrame
        title={
          sourceLabel
            ? `Select repositories to track — ${sourceLabel}`
            : 'Select repositories to track'
        }
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
            {repoCount(data?.total ?? items.length)} visible to this token
            {trackedCount > 0 ? ` · ${trackedCount} already tracked` : ''}
            {selected.size > 0 ? ` · ${selected.size} selected` : ''}
            {data?.truncated ? ' · the forge kept paging, so this list stops at a safety cap' : ''}
          </p>
          {/* INS-28: a filter, because a 256px box of 300 names is a scroll hunt. */}
          {items.length > 8 && (
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name…"
              aria-label="Filter repositories by name"
              className="panel px-2 py-1 text-sm"
              data-testid="repo-picker-filter"
            />
          )}
          <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
            {shown.map((repo) => {
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
            {shown.length === 0 && items.length > 0 && (
              <li className="text-xs text-fg-muted">No repository name contains “{filter}”.</li>
            )}
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
              {select.isPending
                ? 'Starting backfill…'
                : selected.size === 0
                  ? 'Tick repositories to track'
                  : `Track ${repoCount(selected.size)}`}
            </button>
            {/* W20-07 (UX_TODO INS-09): the API always accepted "all"; the
              screen never offered it. It tracks every repository the token can
              see now AND (W20-17) turns on auto-add, so repositories created
              later are tracked by the nightly sync. The connection row's
              "Auto-add" switch turns that off again. */}
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
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="repo-select-all"
                title="Tracks every repository listed here now, and new ones the nightly sync finds later. Turn auto-add off on the connection row."
              >
                Track all {untracked.length} and auto-add new
              </button>
            )}
            {select.isSuccess && (
              <span
                className="flex flex-col gap-0.5 text-xs text-fg-muted"
                role="status"
                data-testid="repo-select-result"
              >
                <span>
                  Backfill queued for {repoCount(select.data.repo_ids.length)} — history fills in as
                  it lands. {/* INS-29: the next place to look, as a link. */}
                  <Link
                    to="/admin/sync"
                    className="text-accent underline-offset-2 hover:underline"
                    data-testid="repo-select-sync-link"
                  >
                    Watch progress in Sync →
                  </Link>
                </span>
                {failed.length > 0 && (
                  <span className="text-warn" data-testid="repo-select-webhook-failed">
                    The forge refused the live-update webhook for {failed.join(', ')}. They still
                    backfill and update nightly; give the token permission to create webhooks for
                    live updates.
                  </span>
                )}
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
    </div>
  );
}
