import { createFileRoute, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { RepoActivity } from '../../../widgets/repo/RepoActivity.js';
import { RepoPerformance } from '../../../widgets/repo/RepoPerformance.js';

// Activity tab (W17-19): composes and links the PR list, CI, hotspots and PR
// flow views. Its own route, like every tab, so it is linkable and restores on
// paste (FR-WEB-2).
//
// W17-21 moved delivery cadence (release cadence, deployment frequency, CI
// turnaround) here from the Performance tab. Those are measured from forge
// metadata, and they sit with the other delivery views; the Performance tab
// now reviews performance findings and links back to this section.
export const Route = createFileRoute('/repos/$repoId/activity')({
  component: ActivityTab,
});

function ActivityTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  return (
    <div className="flex flex-col gap-4">
      <RepoActivity repoId={repoId} window={search.window} search={preserved} />
      <RepoPerformance repoId={repoId} window={search.window} search={preserved} />
    </div>
  );
}
