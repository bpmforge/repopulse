import { createFileRoute, useParams } from '@tanstack/react-router';
import { CiTrends } from '../../../widgets/repo/CiTrends.js';

export const Route = createFileRoute('/repos/$repoId/ci')({
  component: CiTab,
});

function CiTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const { window } = Route.useSearch();
  return <CiTrends repoId={repoId} window={window} />;
}
