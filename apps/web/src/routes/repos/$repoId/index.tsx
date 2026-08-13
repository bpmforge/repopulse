import { createFileRoute, useParams } from '@tanstack/react-router';
import { RepoPulse } from '../../../widgets/repo/RepoPulse.js';

// Pulse is the default tab: /repos/$repoId with no sub-path.
export const Route = createFileRoute('/repos/$repoId/')({
  component: PulseTab,
});

function PulseTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const { window } = Route.useSearch();
  return <RepoPulse repoId={repoId} window={window} />;
}
