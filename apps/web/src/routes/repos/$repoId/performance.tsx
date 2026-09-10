import { createFileRoute, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { RepoPerformance } from '../../../widgets/repo/RepoPerformance.js';

// Performance tab (W17-19): delivery cadence and CI turnaround for one repo.
export const Route = createFileRoute('/repos/$repoId/performance')({
  component: PerformanceTab,
});

function PerformanceTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  return (
    <RepoPerformance
      repoId={repoId}
      window={search.window}
      search={serializeGlobalSearch(search)}
    />
  );
}
