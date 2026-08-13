import { createFileRoute, useParams } from '@tanstack/react-router';
import { FileDetailScreen } from '../../../../widgets/file/FileDetail.js';

// Splat route: the file path is the rest of the URL, so it keeps its slashes
// (FR-WEB-2 deep links) instead of being flattened into one segment.
export const Route = createFileRoute('/repos/$repoId/files/$')({
  component: FileDetailRoute,
});

function FileDetailRoute() {
  const params = useParams({ from: '/repos/$repoId/files/$' }) as {
    repoId: string;
    _splat?: string;
  };
  return <FileDetailScreen repoId={params.repoId} path={params._splat ?? ''} />;
}
