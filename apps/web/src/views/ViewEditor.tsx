import { useState } from 'react';
import { WidgetFrame } from '../components/index.js';
import {
  listWidgets,
  getWidget,
  type WidgetCategory,
} from '../components/widget/WidgetRegistry.js';
import type { Widget, WidgetType } from '../components/widget/types.js';
import { TREND_METRICS } from '../widgets/views/register.js';
import { WINDOW_PRESETS } from '../api/urlState.js';

// Saved-view edit mode (W5-02, UX_SPEC §4.g / DASHBOARD.md §4).
//
// DASHBOARD.md names @dnd-kit for drag/resize. It is NOT in docs/TECH_STACK.md
// and adding a runtime dependency unattended is a stop-and-ask condition
// (MASTER_PROMPT), so resize and reorder are native pointer + keyboard controls
// here. That is not purely a workaround: a drag-only editor is unusable without
// a mouse, and the width/height steppers below are the accessible path WCAG
// 2.2 asks for either way. Swapping in a library later changes this file only —
// the layout-writes-back contract is `onChange(widgets)`.

const CATEGORY_LABEL: Record<WidgetCategory, string> = {
  metrics: 'Metrics',
  lists: 'Lists',
  personal: 'Personal',
  content: 'Content',
};

export interface ViewEditorProps {
  widgets: Widget[];
  onChange: (widgets: Widget[]) => void;
  /** For a trend widget's repository picker (DSH-60). */
  repos?: { id: number; org: string; name: string }[];
}

/**
 * Where a new widget goes (W20-20, UX_TODO DSH-47): beside the last one when
 * it fits in the 12 columns, otherwise at the start of a new row. Every add
 * used to get x: 0, and because the grid places by column start two width-6
 * widgets never sat side by side.
 */
export function nextColumn(widgets: readonly Widget[], width: number): number {
  const last = widgets[widgets.length - 1];
  if (!last) return 0;
  const after = last.layout.x + last.layout.w;
  return after + width <= 12 ? after : 0;
}

export function ViewEditor({ widgets, onChange, repos = [] }: ViewEditorProps) {
  const [picker, setPicker] = useState(false);
  // W20-20 (DSH-47): Remove is one click, so it can be undone.
  const [removed, setRemoved] = useState<{ widget: Widget; index: number } | null>(null);
  const available = listWidgets();
  const byCategory = new Map<WidgetCategory, typeof available>();
  for (const def of available) {
    byCategory.set(def.category, [...(byCategory.get(def.category) ?? []), def]);
  }

  const update = (id: string, patch: Partial<Widget['layout']>) =>
    onChange(widgets.map((w) => (w.id === id ? { ...w, layout: { ...w.layout, ...patch } } : w)));

  /**
   * Per-widget options (W20-05, UX_TODO DSH-60). `undefined` removes the key,
   * so "use the view's window" is an absent option rather than a stored copy
   * of today's window that would stop following the view's scope.
   */
  const setOption = (id: string, key: string, value: string | undefined) =>
    onChange(
      widgets.map((w) => {
        if (w.id !== id) return w;
        const options = { ...(w.options ?? {}) };
        if (value === undefined) delete options[key];
        else options[key] = value;
        const next: Widget = { ...w };
        if (Object.keys(options).length > 0) next.options = options;
        else delete next.options;
        return next;
      }),
    );

  const move = (index: number, delta: number) => {
    const next = [...widgets];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  const add = (type: WidgetType) => {
    const def = getWidget(type);
    const w = def?.defaultSize.w ?? 6;
    onChange([
      ...widgets,
      {
        // Unique per add, so two of the same widget type can coexist — a view
        // with the same trend at two windows is a real thing people build.
        id: `${type}-${widgets.length + 1}-${widgets.reduce((n, w) => n + w.id.length, 0)}`,
        type,
        layout: { x: nextColumn(widgets, w), y: 0, w, h: def?.defaultSize.h ?? 2 },
      },
    ]);
    setPicker(false);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="view-editor">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="add-widget"
          onClick={() => setPicker((v) => !v)}
          aria-expanded={picker}
        >
          Add widget
        </button>
        <span className="text-xs text-fg-muted">{widgets.length} widgets</span>
        {removed && (
          <span className="flex items-center gap-1.5 text-xs text-fg-muted" role="status">
            Removed {getWidget(removed.widget.type)?.title ?? 'a widget'}.
            <button
              type="button"
              className="text-accent hover:underline"
              data-testid="undo-remove"
              onClick={() => {
                const next = [...widgets];
                next.splice(Math.min(removed.index, next.length), 0, removed.widget);
                onChange(next);
                setRemoved(null);
              }}
            >
              Undo
            </button>
          </span>
        )}
      </div>

      {picker && (
        <WidgetFrame title="Add a widget" state="ready">
          <div className="flex flex-col gap-3" data-testid="widget-picker">
            {[...byCategory.entries()].map(([category, defs]) => (
              <div key={category}>
                <h3 className="mb-1 text-xs tracking-wide text-fg-muted uppercase">
                  {CATEGORY_LABEL[category]}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {defs.map((def) => (
                    <button
                      key={def.type}
                      type="button"
                      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      data-testid={`add-widget-${def.type}`}
                      onClick={() => add(def.type)}
                    >
                      {def.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </WidgetFrame>
      )}

      <ul className="flex flex-col gap-2" data-testid="widget-editor-rows">
        {widgets.map((widget, index) => (
          <li
            key={widget.id}
            className="flex flex-wrap items-center gap-2 panel px-3 py-2"
            data-testid={`edit-widget-${widget.id}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              {getWidget(widget.type)?.title ?? `Widget no longer available (${widget.type})`}
            </span>

            {/* The trend widget's options (DSH-60): it always charted M5 and
                the editor had no way to say otherwise. */}
            {widget.type === 'trend' && (
              <>
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  Metric
                  <select
                    className="rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-xs"
                    data-testid={`metric-${widget.id}`}
                    value={
                      typeof widget.options?.metric_key === 'string'
                        ? widget.options.metric_key
                        : 'M5'
                    }
                    onChange={(e) => setOption(widget.id, 'metric_key', e.target.value)}
                  >
                    {TREND_METRICS.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  Window
                  <select
                    className="rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-xs"
                    data-testid={`window-${widget.id}`}
                    value={typeof widget.options?.window === 'string' ? widget.options.window : ''}
                    onChange={(e) => setOption(widget.id, 'window', e.target.value || undefined)}
                  >
                    <option value="">View&apos;s window</option>
                    {WINDOW_PRESETS.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  Repository
                  <select
                    className="rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-xs"
                    data-testid={`repo-${widget.id}`}
                    value={
                      typeof widget.options?.repo_id === 'string' ? widget.options.repo_id : ''
                    }
                    onChange={(e) => setOption(widget.id, 'repo_id', e.target.value || undefined)}
                  >
                    <option value="">Whole organization</option>
                    {repos.map((r) => (
                      <option key={r.id} value={String(r.id)}>
                        {r.org}/{r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {/* W20-20 (UX_TODO DSH-47): the column it starts at, 1-12, so two
                widgets can be put side by side by hand as well. */}
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              Column
              <input
                type="number"
                min={1}
                max={12}
                value={widget.layout.x + 1}
                data-testid={`column-${widget.id}`}
                className="w-14 rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-right"
                onChange={(e) =>
                  update(widget.id, {
                    x: Math.min(11, Math.max(0, (Number(e.target.value) || 1) - 1)),
                  })
                }
              />
            </label>
            {/* Width in 12-col units. A number input rather than a drag handle
                so the grid is operable from a keyboard (WCAG 2.2 AA). */}
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              W
              <input
                type="number"
                min={1}
                max={12}
                value={widget.layout.w}
                data-testid={`width-${widget.id}`}
                className="w-14 rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-right"
                onChange={(e) =>
                  update(widget.id, { w: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              H
              <input
                type="number"
                min={1}
                max={8}
                value={widget.layout.h}
                data-testid={`height-${widget.id}`}
                className="w-14 rounded-sm border border-border bg-surface-2 px-1 py-0.5 text-right"
                onChange={(e) =>
                  update(widget.id, { h: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>

            <button
              type="button"
              className="rounded-sm border border-border px-1.5 py-0.5 text-xs disabled:opacity-50"
              data-testid={`move-up-${widget.id}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Move ${getWidget(widget.type)?.title ?? 'unavailable widget'} earlier`}
            >
              ↑
            </button>
            <button
              type="button"
              className="rounded-sm border border-border px-1.5 py-0.5 text-xs disabled:opacity-50"
              data-testid={`move-down-${widget.id}`}
              disabled={index === widgets.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move ${getWidget(widget.type)?.title ?? 'unavailable widget'} later`}
            >
              ↓
            </button>
            <button
              type="button"
              className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-crit"
              data-testid={`remove-${widget.id}`}
              onClick={() => {
                setRemoved({ widget, index });
                onChange(widgets.filter((w) => w.id !== widget.id));
              }}
              aria-label={`Remove ${getWidget(widget.type)?.title ?? 'unavailable widget'}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
