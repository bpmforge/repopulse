import { createFileRoute, useParams } from '@tanstack/react-router';
import { ReviewBots } from '../../../widgets/repo/ReviewBots.js';

// AI Reviewers tab (W18-23). Its own route like every tab, so a link to it
// restores it (DASHBOARD §1, FR-WEB-2).
export const Route = createFileRoute('/repos/$repoId/ai-reviewers')({
  component: AiReviewersTab,
});

function AiReviewersTab() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const { window } = Route.useSearch();
  return <ReviewBots repoId={repoId} window={window} />;
}
