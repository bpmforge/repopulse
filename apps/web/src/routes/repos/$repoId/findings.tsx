import { useEffect, useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { FindingDetail } from '../../../widgets/findings/FindingDetail.js';
import { FindingSeverityBadge } from '../../../widgets/findings/FindingSeverity.js';
import {
  DEFAULT_STATUS_FILTER,
  STATUS_FILTERS,
  VERIFY_LABEL,
  locationOf,
  type Finding,
  type FindingPage,
} from '../../../widgets/findings/contracts.js';

// The repo's own findings (W16-46).
//
// This tab was a TEASER: a hardcoded WidgetFrame reading "Code review findings
// arrive with Tier-2 analysis (wave W6)", with no request behind it. W6 shipped
// long ago — the explorer lists findings, the weekly pulse counts them, and
// `/findings?repo_id=` had supported this exact filter the whole time. So the
// one screen a reader reaches by drilling into a repository told them the
// feature did not exist yet, while the rest of the product reported its
// results. An honest-sounding sentence is the hardest kind of stale message to
// notice.
//
// The detail panel is the SAME component the explorer uses, mounted here rather
// than linked to, so following a finding does not throw away the repository the
// reader navigated into.
//
// W20-03 (UX_TODO FND-14): the tab showed the first fifty findings, open,
// dismissed and resolved mixed together, and ignored `next_cursor`, so a
// repository with more had no sign that more existed. It now filters by status
// (open by default, in the URL like the explorer's) and pages.

// W20-08 (UX_TODO FND-49): the default is "still to fix" (open + confirmed),
// the one definition every count uses; `open` alone is now a choice.
const STATUSES = STATUS_FILTERS.map((s) => s.value);

function validateFindingsSearch(search: Record<string, unknown>): {
  finding?: number;
  status?: string;
} {
  const raw = search.finding;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  // Still-to-fix is the default and is left out of the URL; `any` is every
  // status.
  const status =
    search.status === 'any' ||
    (typeof search.status === 'string' &&
      search.status !== DEFAULT_STATUS_FILTER &&
      STATUSES.includes(search.status))
      ? (search.status as string)
      : undefined;
  return {
    ...(Number.isInteger(id) && id > 0 ? { finding: id } : {}),
    ...(status ? { status } : {}),
  };
}

/** A status filter in words: `active` reads as "still to fix". */
function statusWords(status: string): string {
  return status === DEFAULT_STATUS_FILTER ? 'still to fix' : status.replace('_', ' ');
}

export const Route = createFileRoute('/repos/$repoId/findings')({
  validateSearch: validateFindingsSearch,
  component: RepoFindings,
});

function RepoFindings() {
  const { repoId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  // The URL is the state, as on the explorer (W16-16): a pasted link and a
  // click have to land on the same screen.
  const search = Route.useSearch();
  const openId = search.finding ?? null;
  const status = search.status === 'any' ? '' : (search.status ?? DEFAULT_STATUS_FILTER);
  const setOpenId = (id: number | null) => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(id === null ? { finding: undefined } : { finding: id }),
      }),
      replace: true,
    });
  };
  const setStatus = (next: string) => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        status: next === '' ? 'any' : next === DEFAULT_STATUS_FILTER ? undefined : next,
      }),
    });
  };

  const filterQuery = { repo_id: repoId, ...(status ? { status } : {}) };
  // Keyset paging, the explorer's stack (W17-22): Next pushes the page's
  // cursor, Previous pops, and a status change is a new list.
  const filterKey = JSON.stringify(filterQuery);
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [];
  const cursor = cursors[cursors.length - 1];

  const listDescriptor = {
    endpoint: '/findings',
    query: { ...filterQuery, ...(cursor ? { cursor } : {}) },
  } as const;

  const { data, isLoading, isError, error, refetch } = useApiQuery<FindingPage>(listDescriptor);

  const items = data?.items ?? [];
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && items.length === 0,
  });

  // Scroll the panel into view, for the reason W16-05 records: it renders below
  // the table, so on a laptop a click on a finding looks like it did nothing.
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (openId === null) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [openId]);

  const openFinding = items.find((f) => f.id === openId);

  return (
    <div className="flex flex-col gap-4" data-testid="repo-findings">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Status
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="repo-filter-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {/* Every other filter, the triage queue and bulk actions live in
            Reviews; this hands over the repository and the status. */}
        <Link
          to="/findings"
          search={
            {
              repos: repoId,
              ...(status === DEFAULT_STATUS_FILTER ? {} : { status: status || 'any' }),
            } as never
          }
          className="text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="repo-findings-in-reviews"
        >
          Open in Reviews, with every filter
        </Link>
      </div>
      <WidgetFrame
        title={
          typeof data?.total === 'number'
            ? `Findings (${data.total.toLocaleString()} ${status ? statusWords(status) : 'in all'})`
            : 'Findings'
        }
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        // Names the reason rather than implying one more run would fix it: this
        // repository has been analysed and nothing was found, OR it has not been
        // analysed — and the reader can tell which from the Security tab's run
        // history, which is where that question belongs.
        emptyMessage={
          status && status !== DEFAULT_STATUS_FILTER
            ? `No ${statusWords(status)} findings in this repository.`
            : 'No findings recorded for this repository. Findings appear once an analysis run completes — the Security tab shows when each scanner last ran.'
        }
      >
        {/* W18-28: scrolls inside its own region at phone width instead of
            squeezing every column until the headers run together. */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Repository findings"
        >
          <table className="table-plain w-full min-w-[44rem] text-sm">
            <caption className="sr-only">Findings in this repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Dimension</th>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody data-testid="repo-finding-rows">
              {items.map((f: Finding) => (
                <tr key={f.id} className="border-t border-border" data-testid={`finding-${f.id}`}>
                  {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                  <td className="py-1 whitespace-nowrap">
                    <FindingSeverityBadge severity={f.severity} />
                  </td>
                  <th scope="row" className="py-1 text-left font-normal">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      data-testid={`finding-open-${f.id}`}
                      onClick={() => setOpenId(f.id === openId ? null : f.id)}
                    >
                      {f.title}
                    </button>
                  </th>
                  <td className="py-1 text-xs">{f.dimension.replace('_', ' ')}</td>
                  {/* locationOf, not a bare `file:line` — W16-40. */}
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
        {(cursors.length > 0 || data?.next_cursor) && (
          <div className="mt-2 flex items-center gap-2 text-xs" data-testid="repo-findings-paging">
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="repo-findings-prev-page"
              disabled={cursors.length === 0}
              onClick={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1) })}
            >
              Previous page
            </button>
            <span className="text-fg-muted">Page {cursors.length + 1}</span>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="repo-findings-next-page"
              disabled={!data?.next_cursor}
              onClick={() => {
                if (data?.next_cursor) {
                  setPaging({ key: filterKey, cursors: [...cursors, data.next_cursor] });
                }
              }}
            >
              Next page
            </button>
          </div>
        )}
      </WidgetFrame>

      {openId !== null && openFinding && (
        <div ref={detailRef}>
          <FindingDetail
            // Remounted per finding (W20-03): a note typed for one finding must
            // not carry over to the next one opened.
            key={openFinding.id}
            finding={openFinding}
            onClose={() => setOpenId(null)}
            invalidate={[queryKeyFor(listDescriptor)]}
          />
        </div>
      )}
    </div>
  );
}
