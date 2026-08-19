import type { Widget, WidgetType } from '../components/widget/types.js';

// Saved-view wire contracts (W5-02). Source of truth is
// apps/api/src/routes/views/schema.ts — the API stores `config.layout` as a
// loose array on purpose (W5-01 declined to pin the widget shape from the API
// side), so the narrowing lives here, in the layer that owns DASHBOARD.md §4's
// Widget model.

export type ViewWindow = '7d' | '30d' | '90d' | '365d';

export interface ViewConfig {
  repo_ids: number[];
  window: ViewWindow;
  layout: Record<string, unknown>[];
}

export interface ViewResponse {
  id: number;
  name: string;
  config: ViewConfig;
  is_shared: boolean;
  share_slug: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ViewListResponse {
  items: ViewResponse[];
  next_cursor: string | null;
}

/**
 * Narrows a stored layout entry to a Widget.
 *
 * Defensive because the API accepts `Record<string, unknown>[]`: a view saved
 * by an older build, or hand-edited, must degrade to a skipped widget rather
 * than crash the whole page. WidgetGrid already renders an unknown TYPE as a
 * placeholder; this guards the case where the row is not a widget at all.
 */
export function toWidget(entry: Record<string, unknown>): Widget | null {
  const { id, type, layout, options, query } = entry as {
    id?: unknown;
    type?: unknown;
    layout?: unknown;
    options?: unknown;
    query?: unknown;
  };
  if (typeof id !== 'string' || typeof type !== 'string') return null;
  const l = (layout ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  // Spread-conditional rather than assigning undefined: the project runs
  // exactOptionalPropertyTypes, so `options: undefined` is NOT the same as an
  // absent key — and an absent key is what "this widget has no options" means.
  const widget: Widget = {
    id,
    type: type as WidgetType,
    layout: { x: num(l.x, 0), y: num(l.y, 0), w: num(l.w, 6), h: num(l.h, 2) },
  };
  if (options && typeof options === 'object') widget.options = options as Record<string, unknown>;
  if (query && typeof query === 'object') widget.query = query as NonNullable<Widget['query']>;
  return widget;
}

export function toWidgets(config: ViewConfig): Widget[] {
  return config.layout.map(toWidget).filter((w): w is Widget => w !== null);
}

/** Widgets back to the stored form. Round-trips through toWidgets unchanged. */
export function fromWidgets(widgets: Widget[]): Record<string, unknown>[] {
  return widgets.map((w) => ({
    id: w.id,
    type: w.type,
    layout: w.layout,
    ...(w.options ? { options: w.options } : {}),
    ...(w.query ? { query: w.query } : {}),
  }));
}
