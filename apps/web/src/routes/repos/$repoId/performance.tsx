import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PerformanceReview } from '../../../widgets/findings/PerformanceReview.js';

// Performance tab (W17-21): a review of performance FINDINGS for one repo.
//
// W17-19 first put delivery cadence here. That is a measured thing, and it now
// lives on the Activity tab where the other delivery views are; this tab links
// to it. What stays under the word "Performance" is what a code reviewer would
// mean by it — places in the code worth a look — with the page's first
// sentence saying that nothing here was timed.
//
// The open finding is URL state (`?finding=`), as on the explorer and the
// repo findings tab, so a reload lands on the same evidence.

function validatePerformanceSearch(search: Record<string, unknown>): { finding?: number } {
  const raw = search.finding;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? { finding: id } : {};
}

export const Route = createFileRoute('/repos/$repoId/performance')({
  validateSearch: validatePerformanceSearch,
  component: PerformanceTab,
});

function PerformanceTab() {
  const { repoId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const openId = search.finding ?? null;
  const setOpenId = (id: number | null) => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(id === null ? { finding: undefined } : { finding: id }),
      }),
      replace: true,
    });
  };
  return (
    <PerformanceReview
      repoId={repoId}
      openId={openId}
      onOpen={setOpenId}
      search={serializeGlobalSearch(search)}
    />
  );
}
