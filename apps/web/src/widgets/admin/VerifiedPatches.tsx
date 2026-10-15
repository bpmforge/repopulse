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
  const { data, isLoading, isError, error, refetch } = useApiQuery<PatchAttempts>({
    endpoint: '/admin/patches',
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
            {total > items.length && (
              <p className="text-xs text-fg-muted">
                Showing the {items.length} most recent of {total} attempts.
              </p>
            )}
          </div>
        )}
      </WidgetFrame>
    </div>
  );
}
