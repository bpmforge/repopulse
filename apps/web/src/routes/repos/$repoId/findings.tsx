import { useEffect, useRef } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { FindingDetail } from '../../../widgets/findings/FindingDetail.js';
import {
  SEVERITY_LABEL,
  VERIFY_LABEL,
  locationOf,
  type Finding,
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

function validateFindingsSearch(search: Record<string, unknown>): { finding?: number } {
  const raw = search.finding;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? { finding: id } : {};
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
  const openId = Route.useSearch().finding ?? null;
  const setOpenId = (id: number | null) => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(id === null ? { finding: undefined } : { finding: id }),
      }),
      replace: true,
    });
  };

  const listDescriptor = {
    endpoint: '/findings',
    query: { repo_id: repoId },
  } as const;

  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    items: Finding[];
    next_cursor: string | null;
  }>(listDescriptor);

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
      <WidgetFrame
        title="Findings"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        // Names the reason rather than implying one more run would fix it: this
        // repository has been analysed and nothing was found, OR it has not been
        // analysed — and the reader can tell which from the Security tab's run
        // history, which is where that question belongs.
        emptyMessage="No findings recorded for this repository. Findings appear once an analysis run completes — the Security tab shows when each scanner last ran."
      >
        <table className="w-full text-sm">
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
            {items.map((f) => (
              <tr key={f.id} className="border-t border-border" data-testid={`finding-${f.id}`}>
                {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                <td className="py-1 whitespace-nowrap">
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
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
                <td className="py-1 text-xs whitespace-nowrap">{VERIFY_LABEL[f.verify_status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>

      {openId !== null && openFinding && (
        <div ref={detailRef}>
          <FindingDetail
            finding={openFinding}
            onClose={() => setOpenId(null)}
            invalidate={[queryKeyFor(listDescriptor)]}
          />
        </div>
      )}
    </div>
  );
}
