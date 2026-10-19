import { createFileRoute, useParams } from '@tanstack/react-router';
import { CiTrends } from '../../../widgets/repo/CiTrends.js';
import { CiPullSetup } from '../../../widgets/repo/CiPullSetup.js';

export const Route = createFileRoute('/repos/$repoId/ci')({
  component: CiTab,
});

function CiTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const { window } = Route.useSearch();
  return (
    <div className="flex flex-col gap-4">
      <CiTrends repoId={repoId} window={window} />
      {/* W20-08 (UX_TODO FND-17): the CI pull's on-ramp, linked to Settings → CI tokens. */}
      <CiPullSetup repoId={repoId} />
    </div>
  );
}
