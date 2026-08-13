import { createFileRoute, useParams } from '@tanstack/react-router';
import { PrFlow } from '../../../widgets/repo/PrFlow.js';

export const Route = createFileRoute('/repos/$repoId/pr-flow')({
  component: PrFlowTab,
});

function PrFlowTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const { window } = Route.useSearch();
  return <PrFlow repoId={repoId} window={window} />;
}
