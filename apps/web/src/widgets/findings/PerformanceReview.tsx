import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { FindingDetail } from './FindingDetail.js';
import { VERIFY_LABEL, locationOf, statusLabel, type Finding } from './contracts.js';
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

/** W20-20 (UX_TODO DSH-92): what the list shows unless someone picks otherwise. */
export const DEFAULT_PERF_STATUS = 'open,confirmed';
const PERF_STATUS_OPTIONS = [
  { value: DEFAULT_PERF_STATUS, label: 'Open' },
  { value: 'dismissed,wont_fix', label: 'Dismissed' },
  { value: 'resolved', label: 'Resolved' },
  { value: '', label: 'All' },
];
/** The API's page size for /findings, for the "11–20 of 43" label. */
const PERF_PAGE_SIZE_HINT = 50;

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

  // W20-20 (UX_TODO DSH-92): open + confirmed by default with a status
  // filter, paged with the API's cursor and counted, instead of the first 50
  // of every status mixed together with no word that the list was cut off.
  const [status, setStatus] = useState<string>(DEFAULT_PERF_STATUS);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];
  const listDescriptor = {
    endpoint: '/findings',
    query: {
      repo_id: repoId,
      dimension: PERFORMANCE_DIMENSION,
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    },
  } as const;
  const findings = useApiQuery<{ items: Finding[]; next_cursor: string | null; total?: number }>(
    listDescriptor,
  );

  const items = findings.data?.items ?? [];
  const total = findings.data?.total;
  const pageStart = cursors.length * PERF_PAGE_SIZE_HINT;
  const review = performanceReviewState(capabilities.data?.capabilities);

  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (openId === null) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [openId]);
  const inPage = items.find((f) => f.id === openId);
  // A linked finding that is not on this page (another status, a later page)
  // is fetched by its id rather than declared missing (DSH-92).
  const single = useApiQuery<Finding>(
    { endpoint: '/findings/{id}', path: { id: openId ?? 0 } },
    { enabled: openId !== null && findings.data !== undefined && !inPage },
  );
  const fetched =
    single.data &&
    single.data.id === openId &&
    String(single.data.repo?.id) === repoId &&
    single.data.dimension === PERFORMANCE_DIMENSION
      ? single.data
      : undefined;
  const openFinding = inPage ?? fetched;
  const missing =
    openId !== null &&
    findings.data !== undefined &&
    !inPage &&
    (single.isError || (single.data !== undefined && !fetched));

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
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
          <label className="flex items-center gap-1">
            Status
            <select
              className="h-7 rounded-md border border-border bg-surface px-1 text-sm text-fg"
              data-testid="performance-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursors([]);
              }}
            >
              {PERF_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {total !== undefined && items.length > 0 && (
            <span data-testid="performance-count">
              {total > items.length
                ? `${pageStart + 1}–${pageStart + items.length} of ${total}`
                : `${items.length} of ${total}`}
            </span>
          )}
          {cursors.length > 0 && (
            <button
              type="button"
              className="text-accent hover:underline"
              data-testid="performance-prev"
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous page
            </button>
          )}
          {findings.data?.next_cursor && (
            <button
              type="button"
              className="text-accent hover:underline"
              data-testid="performance-next"
              onClick={() => setCursors((c) => [...c, findings.data!.next_cursor!])}
            >
              Next page
            </button>
          )}
        </div>
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
                  <td className="py-1 text-xs">{statusLabel(f.status)}</td>
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
      {missing && (
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
