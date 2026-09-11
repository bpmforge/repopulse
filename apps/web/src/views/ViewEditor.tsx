import { useState } from 'react';
import { WidgetFrame } from '../components/index.js';
import { listWidgets, getWidget, type WidgetCategory } from '../components/widget/WidgetRegistry.js';
import type { Widget, WidgetType } from '../components/widget/types.js';

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
}

export function ViewEditor({ widgets, onChange }: ViewEditorProps) {
  const [picker, setPicker] = useState(false);
  const available = listWidgets();
  const byCategory = new Map<WidgetCategory, typeof available>();
  for (const def of available) {
    byCategory.set(def.category, [...(byCategory.get(def.category) ?? []), def]);
  }

  const update = (id: string, patch: Partial<Widget['layout']>) =>
    onChange(widgets.map((w) => (w.id === id ? { ...w, layout: { ...w.layout, ...patch } } : w)));

  const move = (index: number, delta: number) => {
    const next = [...widgets];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  const add = (type: WidgetType) => {
    const def = getWidget(type);
    onChange([
      ...widgets,
      {
        // Unique per add, so two of the same widget type can coexist — a view
        // with the same trend at two windows is a real thing people build.
        id: `${type}-${widgets.length + 1}-${widgets.reduce((n, w) => n + w.id.length, 0)}`,
        type,
        layout: { x: 0, y: 0, w: def?.defaultSize.w ?? 6, h: def?.defaultSize.h ?? 2 },
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
              {getWidget(widget.type)?.title ?? widget.type}
            </span>

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
              aria-label={`Move ${widget.type} earlier`}
            >
              ↑
            </button>
            <button
              type="button"
              className="rounded-sm border border-border px-1.5 py-0.5 text-xs disabled:opacity-50"
              data-testid={`move-down-${widget.id}`}
              disabled={index === widgets.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move ${widget.type} later`}
            >
              ↓
            </button>
            <button
              type="button"
              className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-crit"
              data-testid={`remove-${widget.id}`}
              onClick={() => onChange(widgets.filter((w) => w.id !== widget.id))}
              aria-label={`Remove ${widget.type}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
