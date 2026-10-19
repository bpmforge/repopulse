import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, WidgetGrid, frameState } from '../../../components/index.js';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { ApiError } from '../../../api/client.js';
import { toWidgets, type SharedViewResponse } from '../../../views/contracts.js';

// A shared saved view, opened from its share link (W20-01, UX_TODO DSH-01).
//
// Share produced `/views/shared/{slug}` but the web app had no route for it, so
// every link a lead sent landed on "Page not found". The API side has existed
// since W5-02: any member of the same workspace may resolve the slug (SC-17, it
// is not a public link), and it returns only id, name and config. So this page
// is read-only by construction: there is nothing owner-only to offer.

export const Route = createFileRoute('/views/shared/$slug')({ component: SharedView });

function SharedView() {
  const { slug } = Route.useParams();
  return <SharedViewBody slug={slug} />;
}

export function SharedViewBody({ slug }: { slug: string }) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<SharedViewResponse>({
    endpoint: '/views/shared/{slug}',
    path: { slug },
  });
  const widgets = data ? toWidgets(data.config) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="shared-view">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold" data-testid="shared-view-name">
          {data?.name ?? 'Shared view'}
        </h1>
        <p className="text-xs text-fg-muted">
          A view a colleague shared with this workspace. It is read-only here.
        </p>
      </div>
      <WidgetFrame
        title="Layout"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && widgets.length === 0,
        })}
        {...(error
          ? {
              error,
              // A 404 means the owner stopped sharing it or made a new link;
              // "Not Found" alone reads as a broken app.
              errorMessage:
                error instanceof ApiError && error.status === 404
                  ? 'This link no longer works. The owner may have stopped sharing the view or made a new link. Ask them for the current one.'
                  : error.message,
            }
          : {})}
        onRetry={() => void refetch()}
        emptyMessage="This shared view has no widgets."
      >
        <WidgetGrid widgets={widgets} />
      </WidgetFrame>
    </div>
  );
}
