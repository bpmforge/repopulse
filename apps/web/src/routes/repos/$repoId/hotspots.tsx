import { createFileRoute, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { RepoHotspotsTab } from '../../../widgets/repo/RepoHotspots.js';

export const Route = createFileRoute('/repos/$repoId/hotspots')({
  component: HotspotsTab,
});

function HotspotsTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  return (
    <RepoHotspotsTab
      repoId={repoId}
      window={search.window}
      search={serializeGlobalSearch(search)}
    />
  );
}
