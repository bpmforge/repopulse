import { useEffect, useState } from 'react';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
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
    // PUT, matching the API (W20-01): this was POST, which the API does not
    // route, so Set as home 404'd and changed nothing.
    { endpoint: '/me/default-view', method: 'PUT' },
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
          className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="toggle-edit"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
        <button
          type="button"
          className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="set-as-home"
          disabled={setHome.isPending || data?.is_default === true}
          onClick={() => data && setHome.mutate({ view_id: data.id })}
        >
          {data?.is_default ? '★ Home' : 'Set as home'}
        </button>
        <button
          type="button"
          className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="share-view"
          disabled={share.isPending}
          onClick={() => share.mutate({})}
        >
          {data?.share_slug ? 'Shared' : 'Share'}
        </button>
      </div>

      {data?.share_slug && <ShareLink slug={data.share_slug} />}

      <ErrorNote error={share.error ?? setHome.error ?? save.error} testId="view-action-error" />

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
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="This view has no widgets yet — use Edit to add some."
      >
        <WidgetGrid widgets={widgets} />
      </WidgetFrame>
    </div>
  );
}

/**
 * The share link as something a person can actually send (W20-01, UX_TODO
 * DSH-01): the full address, not a bare path, and a Copy button.
 */
export function ShareLink({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/views/shared/${slug}`;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"
      data-testid="share-slug"
    >
      <span>Anyone signed in to this workspace can open this view:</span>
      <code className="select-all break-all" data-testid="share-url">
        {url}
      </code>
      <button
        type="button"
        className="panel-inset px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="share-copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
