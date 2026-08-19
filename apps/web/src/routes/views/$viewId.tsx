import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, WidgetGrid, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { Widget } from '../../components/widget/types.js';
import { fromWidgets, toWidgets, type ViewResponse } from '../../views/contracts.js';
import { ViewEditor } from '../../views/ViewEditor.js';

// One saved view (W5-02, UX_SPEC §4.g). The SAME WidgetGrid the Org Overview
// uses — views differ from built-in screens by config, not code (DASHBOARD §4).

export const Route = createFileRoute('/views/$viewId')({ component: ViewDetail });

function ViewDetail() {
  const { viewId } = Route.useParams();
  const descriptor = { endpoint: '/views/{id}', path: { id: viewId } } as const;
  const { data, isLoading, isError, error, refetch } = useApiQuery<ViewResponse>(descriptor);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[] | null>(null);

  // The draft seeds from the server copy once loaded. Keyed on updated_at so a
  // refetch after save re-seeds, but typing is never overwritten mid-edit.
  useEffect(() => {
    if (data && draft === null) setDraft(toWidgets(data.config));
  }, [data, draft]);

  const save = useApiMutation<{ config: unknown }, ViewResponse>(
    { ...descriptor, method: 'PATCH' },
    { invalidate: [queryKeyFor(descriptor), queryKeyFor({ endpoint: '/views' })] },
  );
  const share = useApiMutation<Record<string, never>, { share_slug: string }>(
    { endpoint: '/views/{id}/share', path: { id: viewId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor)] },
  );
  const setHome = useApiMutation<{ view_id: number }, unknown>(
    { endpoint: '/me/default-view', method: 'POST' },
    { invalidate: [queryKeyFor(descriptor), queryKeyFor({ endpoint: '/me/context' })] },
  );

  const widgets = draft ?? (data ? toWidgets(data.config) : []);

  return (
    <div className="flex flex-col gap-4" data-testid="view-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold" data-testid="view-name">
          {data?.name ?? 'View'}
        </h1>
        <button
          type="button"
          className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="toggle-edit"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="set-as-home"
          disabled={setHome.isPending || data?.is_default === true}
          onClick={() => data && setHome.mutate({ view_id: data.id })}
        >
          {data?.is_default ? '★ Home' : 'Set as home'}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="share-view"
          disabled={share.isPending}
          onClick={() => share.mutate({})}
        >
          {data?.share_slug ? 'Shared' : 'Share'}
        </button>
      </div>

      {data?.share_slug && (
        <p className="text-xs text-fg-muted" data-testid="share-slug">
          Anyone in this workspace can open this view: <code>/views/shared/{data.share_slug}</code>
        </p>
      )}

      {editing && (
        <>
          <ViewEditor widgets={widgets} onChange={setDraft} />
          <div>
            <button
              type="button"
              className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="save-layout"
              disabled={save.isPending || !data}
              onClick={() =>
                data &&
                save.mutate(
                  { config: { ...data.config, layout: fromWidgets(widgets) } },
                  { onSuccess: () => setEditing(false) },
                )
              }
            >
              Save layout
            </button>
          </div>
        </>
      )}

      <WidgetFrame
        title="Layout"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && widgets.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="This view has no widgets yet — use Edit to add some."
      >
        <WidgetGrid widgets={widgets} />
      </WidgetFrame>
    </div>
  );
}
