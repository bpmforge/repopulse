import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { FindingDetail } from './FindingDetail.js';
import { VERIFY_LABEL, locationOf, type Finding } from './contracts.js';
import {
  PERFORMANCE_DIMENSION,
  PERFORMANCE_REVIEW_DISCLAIMER,
  performanceEmptyCopy,
  performanceReviewState,
  type RepoCapabilities,
} from './performance.js';
import { FindingSeverityBadge } from './FindingSeverity.js';

// Performance review (W17-21).
//
// An honest performance page for a product that never runs the code it looks
// at. It lists the performance FINDINGS for one repository — shapes a rule
// pack or a model flagged — and says, from the canonical capability producer
// (W17-10), whether anything has looked. It shows no runtime figure because
// it has none, and says so in its first sentence.
//
// The detail panel is the explorer's FindingDetail, mounted rather than
// linked, and the open finding lives in the URL (`?finding=`), so a reload or
// a pasted link lands on the same evidence and recommendation.

interface Props {
  repoId: string;
  /** The finding open in the panel, from the URL. */
  openId: number | null;
  onOpen: (id: number | null) => void;
  /** Global search (window etc.) to carry on the Activity link. */
  search: Record<string, string>;
}

export function PerformanceReview({ repoId, openId, onOpen, search }: Props) {
  const capabilities = useApiQuery<RepoCapabilities>({
    endpoint: '/repos/{id}/capabilities',
    path: { id: repoId },
  });

  const listDescriptor = {
    endpoint: '/findings',
    query: { repo_id: repoId, dimension: PERFORMANCE_DIMENSION },
  } as const;
  const findings = useApiQuery<{ items: Finding[]; next_cursor: string | null }>(listDescriptor);

  const items = findings.data?.items ?? [];
  const review = performanceReviewState(capabilities.data?.capabilities);

  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (openId === null) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [openId]);
  const openFinding = items.find((f) => f.id === openId);

  return (
    <div className="flex flex-col gap-4" data-testid="performance-review">
      <WidgetFrame
        title="What this page is"
        state={frameState({
          isLoading: capabilities.isLoading,
          isError: capabilities.isError,
          isEmpty: false,
        })}
        {...(capabilities.error ? { error: capabilities.error } : {})}
        onRetry={() => void capabilities.refetch()}
        testId="performance-provenance"
        drillDown={
          <Link
            to="/repos/$repoId/activity"
            params={{ repoId }}
            search={search as never}
            className="text-xs text-accent underline-offset-2 hover:underline"
            data-testid="performance-to-activity"
          >
            Delivery cadence and CI turnaround →
          </Link>
        }
      >
        <p className="text-sm text-fg-muted" data-testid="performance-disclaimer">
          {PERFORMANCE_REVIEW_DISCLAIMER}
        </p>
        {capabilities.data && (
          <p
            className="mt-2 text-xs text-fg-muted"
            data-testid="performance-coverage"
            data-state={review.kind}
          >
            {review.kind === 'measured' ? (
              <>
                Last reviewed {new Date(review.lastSuccessAt as string).toLocaleDateString()} by{' '}
                {review.measuredBy.join(' and ')}
                {review.lastSuccessRef ? (
                  <>
                    {' '}
                    at commit{' '}
                    <code className="font-mono">{review.lastSuccessRef.slice(0, 12)}</code>
                  </>
                ) : null}
                .
                {review.stale
                  ? ' Older than the freshness window — the code may have moved on.'
                  : ''}
                {review.latestFailed
                  ? ' A later attempt failed; these are the last finished run.'
                  : ''}
              </>
            ) : (
              performanceEmptyCopy(review)
            )}
          </p>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="Performance findings"
        state={frameState({
          isLoading: findings.isLoading,
          isError: findings.isError,
          isEmpty: findings.data !== undefined && items.length === 0,
        })}
        {...(findings.error ? { error: findings.error } : {})}
        onRetry={() => void findings.refetch()}
        // The empty sentence comes from the capability state, never a fixed
        // excuse: no provider, not run, running, failed and measured-clean are
        // five different facts (W17-10, W17-20).
        emptyMessage={performanceEmptyCopy(review)}
        testId="performance-findings"
      >
        {/* W18-28: scrolls inside its own region at phone width instead of
            squeezing every column until the headers run together. */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Performance findings"
        >
          <table className="table-plain w-full min-w-[44rem] text-sm">
            <caption className="sr-only">Performance findings in this repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Source</th>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody data-testid="performance-finding-rows">
              {items.map((f) => (
                <tr key={f.id} className="border-t border-border" data-testid={`finding-${f.id}`}>
                  <td className="py-1 whitespace-nowrap">
                    <FindingSeverityBadge severity={f.severity} />
                  </td>
                  <th scope="row" className="py-1 text-left font-normal">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      data-testid={`finding-open-${f.id}`}
                      aria-expanded={f.id === openId}
                      onClick={() => onOpen(f.id === openId ? null : f.id)}
                    >
                      {f.title}
                    </button>
                  </th>
                  {/* Which producer said so: a pattern rule and a model's
                      judgement are different kinds of claim. */}
                  <td className="py-1 text-xs">
                    {f.rule_id ?? (f.scanner_key ? f.scanner_key : `Tier ${f.tier} review`)}
                  </td>
                  <td className="py-1 font-mono text-xs">{locationOf(f)}</td>
                  <td className="py-1 text-xs">{f.status.replace('_', ' ')}</td>
                  <td className="py-1 text-xs whitespace-nowrap">
                    {VERIFY_LABEL[f.verify_status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>

      {openId !== null && openFinding && (
        <div ref={detailRef}>
          <FindingDetail
            finding={openFinding}
            onClose={() => onOpen(null)}
            invalidate={[queryKeyFor(listDescriptor)]}
          />
        </div>
      )}
      {openId !== null && findings.data && !openFinding && (
        <p
          className="text-sm text-fg-muted"
          role="status"
          data-testid="performance-finding-missing"
        >
          No performance finding with that id is in this repository. The link may be old, or the
          finding may belong to another repository.
        </p>
      )}
    </div>
  );
}
