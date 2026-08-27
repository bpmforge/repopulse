import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';
import type { ViewListResponse, ViewResponse } from '../../views/contracts.js';
import { templateConfig, templatesFor } from '../../views/templates.js';

// Views list (W5-02, UX_SPEC §4.g/§6).
//
// The rail has linked here since W4-02 and the route did not exist — clicking
// "Views" landed on nothing.

export const Route = createFileRoute('/views/')({ component: ViewsIndex });

const LIST = { endpoint: '/views' } as const;

function ViewsIndex() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const navigate = useNavigate();

  const { data, isLoading, isError, error, refetch } = useApiQuery<ViewListResponse>(LIST);
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  const createView = useApiMutation<{ name: string; config: unknown }, ViewResponse>(
    { endpoint: '/views', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const items = data?.items ?? [];
  const templates = templatesFor(me?.persona ?? null);

  return (
    <div className="flex flex-col gap-4" data-testid="views">
      <WidgetFrame
        title="Saved views"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
      >
        {items.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="view-list">
            {items.map((view) => (
              <li key={view.id} className="flex items-center gap-2 border-t border-border py-1.5 first:border-t-0">
                <Link
                  to="/views/$viewId"
                  params={{ viewId: String(view.id) }}
                  search={preserved as never}
                  className="flex-1 text-accent hover:underline"
                  data-testid={`view-link-${view.id}`}
                >
                  {view.name}
                </Link>
                {/* Paired mark + text, never colour alone (UX_SPEC §7). */}
                {view.is_default && <span className="text-xs text-fg-muted">★ home</span>}
                {view.is_shared && <span className="text-xs text-fg-muted">⇄ shared</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            No saved views yet. Start from a template below — you can change everything afterwards.
          </p>
        )}
      </WidgetFrame>

      {/* §6 starter gallery. Shown even when views exist: the second view is
          harder to design than the first, and the templates are the only place
          the widget vocabulary is visible without entering edit mode. */}
      <WidgetFrame title="Start from a template" state="ready">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="template-gallery">
          {templates.map((template) => (
            <div key={template.id} className="rounded-md border border-border bg-surface p-3">
              <h3 className="text-sm font-medium">{template.name}</h3>
              <p className="mt-1 text-xs text-fg-muted">{template.description}</p>
              <button
                type="button"
                className="mt-2 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`use-template-${template.id}`}
                disabled={createView.isPending}
                onClick={() =>
                  createView.mutate(
                    { name: template.name, config: templateConfig(template) },
                    {
                      onSuccess: (view) =>
                        void navigate({
                          to: '/views/$viewId',
                          params: { viewId: String(view.id) },
                          search: preserved as never,
                        }),
                    },
                  )
                }
              >
                Use this template
              </button>
            </div>
          ))}
        </div>
      </WidgetFrame>
    </div>
  );
}
