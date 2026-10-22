import { Link } from '@tanstack/react-router';
import {
  HEALTH_BAND_LABEL,
  SeverityBadge,
  WidgetFrame,
  frameState,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { useBackfill } from '../../lib/backfill.js';
import { intentWarningText, type AttentionItems } from './contracts.js';

// UX_SPEC §4.a "Needs attention": every measured repository scoring below the
// healthy band, worst first.
//
// W20-05 (UX_TODO DSH-09). This used to say "Nothing new since your last
// visit" and stamp a lastSeenAt on every successful load, but the API never
// read `since` — it listed every repository in band C/D/E each time. The empty
// state therefore claimed a diff nobody computed. The since-diff (new stale
// PRs, CI regressions, unreviewed merges) needs event streams that do not
// exist yet, so the card now says what it actually shows, and marks nothing
// seen.
//
// W20-05 (UX_TODO DSH-10). The band is the health badge's own 3-band ramp
// (healthBand in @repopulse/shared/health-band, applied by the API), so a
// repository at 72 is "watch" here AND on the grid beside it.

interface Props {
  window: string;
  search: Record<string, string>;
}

/** Severity tint per band — paired with the band's word, never colour alone. */
const BAND_SEVERITY: Record<AttentionItems['items'][number]['band'], 'medium' | 'high'> = {
  watch: 'medium',
  attend: 'high',
};

export function AttentionFeed({ window, search }: Props) {
  // The saved view's or topbar's repo scope (W20-05, DSH-02).
  const repos = search.repos && search.repos !== 'all' ? search.repos : undefined;
  const { data, isLoading, isError, error, refetch } = useApiQuery<AttentionItems>({
    endpoint: '/org/attention',
    query: { window, ...(repos ? { repos } : {}) },
  });

  const items = data?.items ?? [];
  // W20-24 (UX_TODO DSH-37): intents whose promise lapsed, beside the
  // repositories. A file someone said they would refactor and has not is
  // exactly the thing this card is for.
  const intents = data?.intents ?? [];
  const backfill = useBackfill();

  return (
    <WidgetFrame
      title="Needs attention"
      // W20-22 (UX_TODO INS-35): an empty list while history loads is
      // "still loading", not "nothing here".
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && items.length === 0 && intents.length === 0,
        isSyncing: backfill.syncing,
      })}
      syncPct={backfill.pct}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="Every measured repository is in the healthy band (75 or above), and no file intent needs a look."
    >
      {items.length > 0 ? (
        <p className="mb-2 text-xs text-fg-muted" data-testid="attention-caption">
          Repositories scoring below 75, lowest first.
        </p>
      ) : (
        <p className="mb-2 text-xs text-fg-muted" data-testid="attention-caption">
          Every measured repository is in the healthy band (75 or above).
        </p>
      )}
      <ul className="flex flex-col gap-2" data-testid="attention-feed">
        {items.map((item) => (
          <li key={`${item.kind}:${item.repo_id}`}>
            <Link
              to="/repos/$repoId"
              params={{ repoId: String(item.repo_id) }}
              search={search as never}
              className="flex items-center justify-between gap-2 panel px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`attention-${item.repo_id}`}
            >
              <span className="truncate">
                <span className="text-fg-muted">{item.org}/</span>
                {item.name}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-fg-muted">{item.score}</span>
                <SeverityBadge
                  severity={BAND_SEVERITY[item.band] ?? 'medium'}
                  label={HEALTH_BAND_LABEL[item.band] ?? 'watch'}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {intents.length > 0 && (
        <>
          <p className="mb-2 mt-3 text-xs text-fg-muted" data-testid="attention-intents-caption">
            File intents that need a look, longest-standing first.
          </p>
          <ul className="flex flex-col gap-2" data-testid="attention-intents">
            {intents.map((i) => (
              <li key={`${i.repo_id}:${i.path}:${i.kind}`}>
                <Link
                  to="/repos/$repoId/files/$"
                  params={{ repoId: String(i.repo_id), _splat: i.path } as never}
                  search={search as never}
                  className="flex flex-col gap-0.5 panel px-3 py-2 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`attention-intent-${i.repo_id}-${i.path}`}
                >
                  <span className="truncate">
                    <span className="text-fg-muted">
                      {i.org}/{i.name} ·{' '}
                    </span>
                    {i.path}
                  </span>
                  <span className="text-xs text-warn">⚠ {intentWarningText(i)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </WidgetFrame>
  );
}
