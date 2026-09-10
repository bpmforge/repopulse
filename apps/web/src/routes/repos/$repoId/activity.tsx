import { createFileRoute, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { RepoActivity } from '../../../widgets/repo/RepoActivity.js';

// Activity tab (W17-19): composes and links the PR list, CI, hotspots and PR
// flow views. Its own route, like every tab, so it is linkable and restores on
// paste (FR-WEB-2).
export const Route = createFileRoute('/repos/$repoId/activity')({
  component: ActivityTab,
});

function ActivityTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  return (
    <RepoActivity repoId={repoId} window={search.window} search={serializeGlobalSearch(search)} />
  );
}
