import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useApiMutation, queryKeyFor } from '../api/useApiQuery.js';
import { ErrorNote } from '../components/primitives/ErrorNote.js';
import type { Widget } from '../components/widget/types.js';
import { fromWidgets, type ViewConfig, type ViewResponse, type ViewWindow } from './contracts.js';

// "Save as view…" (W20-05, UX_TODO DSH-07; UX_SPEC §4.g puts it on every
// dashboard). The only way to make a view was a template, so a lead who had
// narrowed the Overview to the three repositories they own could not keep that.
//
// It captures what is on screen: the current window, the topbar's repository
// filter and the dashboard's layout. Widget options are stripped on the way in
// — the built-in screens pass the CURRENT window through every widget, and a
// stored copy of it would pin the new view to today's filter instead of
// following the view's own scope.

const VIEW_WINDOWS: readonly ViewWindow[] = ['7d', '30d', '90d', '365d'];

export interface SaveAsViewProps {
  /** The dashboard's widgets, as rendered. */
  widgets: Widget[];
  window: string;
  /** The topbar's `repos` csv, or `all` / undefined for every repository. */
  repos: string | undefined;
  /** Suggested name — the screen's own title. */
  defaultName: string;
}

/** The new view's config from what is on screen. Exported for its test. */
export function configFromScreen(
  widgets: Widget[],
  window: string,
  repos: string | undefined,
): ViewConfig {
  const repoIds =
    repos && repos !== 'all'
      ? repos
          .split(',')
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];
  return {
    repo_ids: repoIds,
    window: (VIEW_WINDOWS as readonly string[]).includes(window) ? (window as ViewWindow) : '30d',
    layout: fromWidgets(widgets.map((w) => ({ id: w.id, type: w.type, layout: w.layout }))),
  };
}

export function SaveAsViewButton({ widgets, window, repos, defaultName }: SaveAsViewProps) {
  const navigate = useNavigate();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(defaultName);
  const create = useApiMutation<{ name: string; config: ViewConfig }, ViewResponse>(
    { endpoint: '/views', method: 'POST' },
    { invalidate: [queryKeyFor({ endpoint: '/views' })] },
  );

  if (!naming) {
    return (
      <button
        type="button"
        className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="save-as-view"
        onClick={() => setNaming(true)}
      >
        Save as view…
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="save-as-view-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim().length === 0) return;
        create.mutate(
          { name: name.trim(), config: configFromScreen(widgets, window, repos) },
          {
            onSuccess: (view) =>
              void navigate({ to: '/views/$viewId', params: { viewId: String(view.id) } }),
          },
        );
      }}
    >
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        View name
        <input
          type="text"
          className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
          data-testid="save-as-view-name"
          value={name}
          maxLength={200}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        data-testid="save-as-view-submit"
        disabled={create.isPending || name.trim().length === 0}
      >
        Save view
      </button>
      <button
        type="button"
        className="panel-inset px-3 py-1.5 text-sm"
        onClick={() => setNaming(false)}
      >
        Cancel
      </button>
      <ErrorNote error={create.error} testId="save-as-view-error" />
    </form>
  );
}
