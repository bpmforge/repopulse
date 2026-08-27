import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { SeverityBadge, WidgetFrame, frameState, useUiStore } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { AttentionItems } from './contracts.js';

// UX_SPEC §4.a: "what changed since you last looked", computed vs last_seen_at.
//
// lastSeenAt is CLIENT state (DASHBOARD §2: zustand + localStorage persist), sent
// to the API as ?since — there is no per-user column server-side. The stamp is
// only advanced AFTER a successful fetch: marking on mount would consume the
// unseen window even when the request failed, silently losing the very changes
// the feed exists to surface.

interface Props {
  window: string;
  search: Record<string, string>;
}

/** Health bands the API flags: C/D/E, worst first. */
const BAND_SEVERITY: Record<string, 'low' | 'medium' | 'high'> = {
  C: 'low',
  D: 'medium',
  E: 'high',
};

export function AttentionFeed({ window, search }: Props) {
  const lastSeenAt = useUiStore((s) => s.lastSeenAt);
  const markSeen = useUiStore((s) => s.markSeen);

  const { data, isLoading, isError, error, refetch, isSuccess } = useApiQuery<AttentionItems>({
    endpoint: '/org/attention',
    query: { window, ...(lastSeenAt ? { since: lastSeenAt } : {}) },
  });

  useEffect(() => {
    if (isSuccess) markSeen(new Date().toISOString());
  }, [isSuccess, markSeen]);

  const items = data?.items ?? [];

  return (
    <WidgetFrame
      title="Needs attention"
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && items.length === 0,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage={
        lastSeenAt ? 'Nothing new since your last visit.' : 'Nothing is asking for attention.'
      }
    >
      <ul className="flex flex-col gap-2" data-testid="attention-feed">
        {items.map((item) => (
          <li key={`${item.kind}:${item.repo_id}`}>
            <Link
              to="/repos/$repoId"
              params={{ repoId: String(item.repo_id) }}
              search={search as never}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`attention-${item.repo_id}`}
            >
              <span className="truncate">{item.name}</span>
              <SeverityBadge severity={BAND_SEVERITY[item.band] ?? 'low'} />
            </Link>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
