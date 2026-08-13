import { createFileRoute, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PrDetailScreen } from '../../../../widgets/pr/PrDetail.js';

export const Route = createFileRoute('/repos/$repoId/prs/$number')({
  component: PrDetailRoute,
});

function PrDetailRoute() {
  const { repoId, number } = useParams({ from: '/repos/$repoId/prs/$number' });
  const search = Route.useSearch();
  return (
    <PrDetailScreen repoId={repoId} number={number} search={serializeGlobalSearch(search)} />
  );
}
