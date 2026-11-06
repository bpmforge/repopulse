import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';
import {
  isFindingsView,
  isRepoSetView,
  type ViewListResponse,
  type ViewResponse,
} from '../../views/contracts.js';
import { templateConfig, templatesFor } from '../../views/templates.js';

// Views list (W5-02, UX_SPEC §4.g/§6).
//
// The rail has linked here since W4-02 and the route did not exist — clicking
// "Views" landed on nothing.

export const Route = createFileRoute('/views/')({ component: ViewsIndex });

const LIST = { endpoint: '/views' } as const;
/** W20-16 (UX_TODO DSH-66): views colleagues shared with the workspace. */
const SHARED = { endpoint: '/views', query: { scope: 'shared' } } as const;

/**
 * One saved view's row. A Findings view (W20-16, FND-03) opens the explorer
 * with its filters directly; a repository set (W20-23, X-06) opens the
 * repository list narrowed to it; a dashboard opens its own page.
 */
function ViewRow({ view, preserved }: { view: ViewResponse; preserved: Record<string, unknown> }) {
  const findings = isFindingsView(view.config);
  const repoSet = isRepoSetView(view.config);
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-border py-1.5 first:border-t-0">
      {repoSet ? (
        <Link
          to="/repos"
          search={{ ...preserved, repos: view.config.repo_ids.join(',') } as never}
          className="flex-1 text-accent hover:underline"
          data-testid={`view-link-${view.id}`}
        >
          {view.name}
        </Link>
      ) : findings ? (
        <Link
          to="/findings"
          search={(view.config.search ?? {}) as never}
          className="flex-1 text-accent hover:underline"
          data-testid={`view-link-${view.id}`}
        >
          {view.name}
        </Link>
      ) : (
        <Link
          to="/views/$viewId"
          params={{ viewId: String(view.id) }}
          search={preserved as never}
          className="flex-1 text-accent hover:underline"
          data-testid={`view-link-${view.id}`}
        >
          {view.name}
        </Link>
      )}
      {findings && <span className="text-xs text-fg-muted">Findings filters</span>}
      {repoSet && (
        <span className="text-xs text-fg-muted" data-testid={`view-kind-${view.id}`}>
          Repository set · {view.config.repo_ids.length}{' '}
          {view.config.repo_ids.length === 1 ? 'repository' : 'repositories'}
        </span>
      )}
      {(findings || repoSet) && (
        <Link
          to="/views/$viewId"
          params={{ viewId: String(view.id) }}
          className="text-xs text-fg-muted underline-offset-2 hover:underline"
          data-testid={`view-manage-${view.id}`}
        >
          Manage
        </Link>
      )}
      {/* Paired mark + text, never colour alone (UX_SPEC §7). */}
      {view.is_default && <span className="text-xs text-fg-muted">★ home</span>}
      {view.is_shared && <span className="text-xs text-fg-muted">⇄ shared</span>}
    </li>
  );
}

function ViewsIndex() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const navigate = useNavigate();

  const { data, isLoading, isError, error, refetch } = useApiQuery<ViewListResponse>(LIST);
  const shared = useApiQuery<ViewListResponse>(SHARED);
  // W20-16 (UX_TODO DSH-54): a template asks for a name first, prefilled —
  // two clicks made two identical "Team delivery" views.
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  const createView = useApiMutation<{ name: string; config: unknown }, ViewResponse>(
    { endpoint: '/views', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const items = data?.items ?? [];
  const templates = templatesFor(me?.persona ?? null);

  return (
    <div className="flex flex-col gap-4" data-testid="views">
      <PageHeader
        title="Saved Views"
        description="Named dashboards — a filter scope and a layout you can share by URL."
      />
      <WidgetFrame
        title="Saved views"
        state={frameState({ isLoading, isError, isEmpty: false })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
      >
        {items.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="view-list">
            {items.map((view) => (
              <ViewRow key={view.id} view={view} preserved={preserved} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            No saved views yet. Start from a template below — you can change everything afterwards.
            On Findings, &ldquo;Save filters as view…&rdquo; keeps a set of filters here too, and
            the Repositories filter at the top can save a repository set.
          </p>
        )}
      </WidgetFrame>

      {(shared.data?.items.length ?? 0) > 0 && (
        <WidgetFrame title="Shared with me" state="ready">
          <ul className="flex flex-col gap-1" data-testid="view-list-shared">
            {(shared.data?.items ?? []).map((view) => (
              <ViewRow key={view.id} view={view} preserved={preserved} />
            ))}
          </ul>
        </WidgetFrame>
      )}

      {/* §6 starter gallery. Shown even when views exist: the second view is
          harder to design than the first, and the templates are the only place
          the widget vocabulary is visible without entering edit mode. */}
      <WidgetFrame title="Start from a template" state="ready">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="template-gallery">
          {templates.map((template) => (
            <div key={template.id} className="panel p-3">
              <h3 className="text-sm font-medium">{template.name}</h3>
              <p className="mt-1 text-xs text-fg-muted">{template.description}</p>
              {naming?.id === template.id ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-1.5"
                  data-testid={`template-name-form-${template.id}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = naming.name.trim();
                    if (!name) return;
                    createView.mutate(
                      { name, config: templateConfig(template) },
                      {
                        onSuccess: (view) =>
                          void navigate({
                            to: '/views/$viewId',
                            params: { viewId: String(view.id) },
                            search: preserved as never,
                          }),
                      },
                    );
                  }}
                >
                  <label className="flex items-center gap-1 text-xs text-fg-muted">
                    Name
                    <input
                      type="text"
                      className="rounded-sm border border-border bg-surface-2 px-2 py-0.5 text-xs text-fg"
                      data-testid={`template-name-${template.id}`}
                      value={naming.name}
                      maxLength={200}
                      autoFocus
                      onChange={(e) => setNaming({ id: template.id, name: e.target.value })}
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-md btn-primary px-2 py-0.5 text-xs disabled:opacity-50"
                    data-testid={`create-from-template-${template.id}`}
                    disabled={createView.isPending || naming.name.trim().length === 0}
                  >
                    Create view
                  </button>
                  <button
                    type="button"
                    className="panel-inset px-2 py-0.5 text-xs"
                    onClick={() => setNaming(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="mt-2 panel-inset px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`use-template-${template.id}`}
                  disabled={createView.isPending}
                  onClick={() => {
                    // A name not already taken, so the default is usable as is.
                    const taken = new Set(items.map((v) => v.name));
                    let name = template.name;
                    for (let n = 2; taken.has(name); n += 1) name = `${template.name} (${n})`;
                    setNaming({ id: template.id, name });
                  }}
                >
                  Use this template
                </button>
              )}
            </div>
          ))}
        </div>
        <ErrorNote error={createView.error} testId="template-create-error" />
      </WidgetFrame>
    </div>
  );
}
