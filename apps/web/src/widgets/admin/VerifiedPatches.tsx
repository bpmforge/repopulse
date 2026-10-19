import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';

// Verified fixes (W18-29, over W18-19's GET /admin/patches).
//
// The finding drawer shows a developer a fix only once the re-scan proved it;
// a rejected attempt shows them nothing. This is the other side: where an
// admin reads every attempt and WHY the rejected ones were rejected — a model
// that keeps writing diffs that do not apply, or a rule that every fix trips.
//
// Counts are outcomes, not a score: no rate is computed and nothing is graded.
// Nothing here writes to a forge (D9a); a fix only ever leaves as a copy or a
// download from the finding.

export interface PatchAttempt {
  id: number;
  finding_id: number;
  status: 'pending' | 'verified' | 'rejected' | 'failed';
  reason_code: string | null;
  reason: string | null;
  model_id: string | null;
  tier: number;
  created_at: string;
  finished_at: string | null;
  finding: { title: string | null; file: string | null };
  repo: { id: number; name: string | null };
}

export interface PatchAttempts {
  counts: Partial<Record<PatchAttempt['status'], number>>;
  items: PatchAttempt[];
  /** W20-11 (UX_TODO AI-66): every model that drafted an attempt, for the filter. */
  models?: string[];
  /** Repositories with any attempt, for the filter. */
  repos?: { id: number; name: string }[];
  /** Pass back as `before` for older attempts; null on the last page. */
  next_cursor?: string | null;
}

interface Gateway {
  configured: boolean;
}

const STATUS_WORD: Record<PatchAttempt['status'], string> = {
  verified: 'verified',
  rejected: 'rejected',
  failed: 'failed to run',
  pending: 'in progress',
};

/** Paired mark + word; the mark is decoration and the word carries the meaning. */
const STATUS_MARK: Record<PatchAttempt['status'], string> = {
  verified: '✓',
  rejected: '✕',
  failed: '!',
  pending: '…',
};

const ORDER: PatchAttempt['status'][] = ['verified', 'rejected', 'failed', 'pending'];

export function VerifiedPatches() {
  // W20-11 (UX_TODO AI-66): filter by outcome, model and repository, and page back past the
  // hundred newest. Page cursors are kept so "Newer" can return.
  const [status, setStatus] = useState<PatchAttempt['status'] | ''>('');
  const [model, setModel] = useState('');
  const [repoId, setRepoId] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors[cursors.length - 1];
  const filtered = status !== '' || model !== '' || repoId !== '' || before !== undefined;
  const { data, isLoading, isError, error, refetch } = useApiQuery<PatchAttempts>({
    endpoint: '/admin/patches',
    ...(filtered
      ? {
          query: {
            ...(status ? { status } : {}),
            ...(model ? { model } : {}),
            ...(repoId ? { repo_id: repoId } : {}),
            ...(before ? { before } : {}),
          },
        }
      : {}),
  });
  // Whether a fix CAN be drafted at all: Tier 2 needs a configured model.
  const { data: analysis } = useApiQuery<{ gateway?: Gateway }>({ endpoint: '/admin/analysis' });
  const gateway = analysis?.gateway;
  const unavailable = gateway !== undefined && !gateway.configured;

  const items = data?.items ?? [];
  const total = ORDER.reduce((n, s) => n + (data?.counts[s] ?? 0), 0);

  // Our own sentence rather than the gateway's reason: that one is written for
  // the analysis screen ("scheduled passes will skip") and names a path this
  // screen links to anyway.
  const emptyMessage = unavailable
    ? 'No fix can be drafted yet: drafting needs a Tier-2 model, and none is configured.'
    : 'No fix has been drafted yet. A member asks for one from a finding’s panel (“Draft a verified fix”); every attempt, verified or not, is listed here with its reason.';

  return (
    <div className="flex flex-col gap-4" data-testid="verified-patches">
      {unavailable && total > 0 && (
        <p
          className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
          role="status"
          data-testid="patches-unavailable"
        >
          <strong>New fixes cannot be drafted:</strong> drafting needs a Tier-2 model, and none is
          configured.{' '}
          <Link to="/admin/models" className="font-medium text-fg underline underline-offset-2">
            Configure a model →
          </Link>
        </p>
      )}

      <WidgetFrame
        title="Verified fixes"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && total === 0 })}
        onRetry={() => void refetch()}
        {...(error ? { errorMessage: error.message, error } : {})}
        emptyMessage={emptyMessage}
        emptyAction={
          unavailable ? (
            <Link
              to="/admin/models"
              className="min-h-6 text-xs font-medium text-fg underline underline-offset-2"
              data-testid="patches-configure-model"
            >
              Configure a model →
            </Link>
          ) : undefined
        }
        testId={unavailable && total === 0 ? 'patches-unavailable-empty' : 'patches-frame'}
      >
        {data && total > 0 && (
          <div className="flex flex-col gap-3">
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm" data-testid="patch-counts">
              {ORDER.map((s) => (
                <div key={s} className="flex flex-col">
                  <dt className="text-xs text-fg-muted">{STATUS_WORD[s]}</dt>
                  <dd className="text-lg tabular-nums" data-testid={`patch-count-${s}`}>
                    {data.counts[s] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-fg-muted">
              A fix is shown to developers only when re-scanning the patched file cleared the
              finding and raised nothing new. Nothing is ever written to the repository.
            </p>
            <div className="flex flex-wrap items-end gap-3 text-xs" data-testid="patch-filters">
              <label className="flex flex-col gap-1 text-fg-muted">
                Outcome
                <select
                  className="panel px-2 py-1 text-sm"
                  data-testid="patch-filter-status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as PatchAttempt['status'] | '');
                    setCursors([]);
                  }}
                >
                  <option value="">Every outcome</option>
                  {ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_WORD[s]}
                    </option>
                  ))}
                </select>
              </label>
              {(data.models ?? []).length > 0 ? (
                <label className="flex flex-col gap-1 text-fg-muted">
                  Model
                  <select
                    className="panel px-2 py-1 text-sm"
                    data-testid="patch-filter-model"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setCursors([]);
                    }}
                  >
                    <option value="">Every model</option>
                    {(data.models ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {(data.repos ?? []).length > 1 ? (
                <label className="flex flex-col gap-1 text-fg-muted">
                  Repository
                  <select
                    className="panel px-2 py-1 text-sm"
                    data-testid="patch-filter-repo"
                    value={repoId}
                    onChange={(e) => {
                      setRepoId(e.target.value);
                      setCursors([]);
                    }}
                  >
                    <option value="">Every repository</option>
                    {(data.repos ?? []).map((x) => (
                      <option key={x.id} value={String(x.id)}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {items.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="patch-list-empty">
                No attempt matches these filters.
              </p>
            ) : null}
            <ul className="flex flex-col" data-testid="patch-list">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col gap-1 border-t border-border py-2"
                  data-testid={`patch-${p.id}`}
                  data-status={p.status}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="text-xs whitespace-nowrap text-fg-muted">
                      <span aria-hidden="true">{STATUS_MARK[p.status]} </span>
                      {STATUS_WORD[p.status]}
                    </span>
                    <Link
                      to="/findings"
                      search={{ finding: p.finding_id } as never}
                      className="min-h-6 text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {p.finding.title ?? `Finding #${p.finding_id}`}
                    </Link>
                  </div>
                  <p className="text-xs break-words text-fg-muted">
                    {p.repo.name ?? 'repository removed'}
                    {p.finding.file ? (
                      <>
                        {' · '}
                        <span className="font-mono break-all">{p.finding.file}</span>
                      </>
                    ) : null}
                    {` · Tier ${p.tier}`}
                    {p.model_id ? ` · ${p.model_id}` : ''}
                    {` · ${p.created_at.slice(0, 10)}`}
                  </p>
                  {p.status !== 'verified' && p.status !== 'pending' && (
                    <p className="text-xs text-fg" data-testid={`patch-reason-${p.id}`}>
                      {p.reason ?? p.reason_code ?? 'No reason was recorded.'}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {total > items.length && !filtered && !data.next_cursor && (
              <p className="text-xs text-fg-muted">
                Showing the {items.length} most recent of {total} attempts.
              </p>
            )}
            {data.next_cursor || cursors.length > 0 ? (
              <div className="flex gap-3 text-xs" data-testid="patch-paging">
                {cursors.length > 0 ? (
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    data-testid="patch-newer"
                    onClick={() => setCursors((c) => c.slice(0, -1))}
                  >
                    ← Newer attempts
                  </button>
                ) : null}
                {data.next_cursor ? (
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    data-testid="patch-older"
                    onClick={() => {
                      const next = data.next_cursor;
                      if (next) setCursors((c) => [...c, next]);
                    }}
                  >
                    Older attempts →
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </WidgetFrame>
    </div>
  );
}
