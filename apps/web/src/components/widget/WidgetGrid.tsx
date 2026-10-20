import type { CSSProperties } from 'react';
import { WidgetFrame } from './WidgetFrame.js';
import { getWidget } from './WidgetRegistry.js';
import type { Widget } from './types.js';

// WidgetGrid (DASHBOARD §4): renders Widget[] on a 12-col CSS grid — the SAME
// engine for the built-in Org Overview and user-defined saved views (they
// differ by config, not code). An unregistered type degrades to a placeholder
// frame instead of crashing the whole grid.
//
// W17-15 — placement is CSS-only, and the saved layout is read, never written:
// x/w become a column start + span on the md-and-up 12-col grid and h a row
// span, while below md every widget is one full-width row (grid-cols-1) so a
// ~390px viewport stacks instead of scrolling sideways. Out-of-range saved
// values are clamped for display only; the stored numbers are echoed verbatim
// on data-x/y/w/h and are never reinterpreted or migrated.
//
// Rows deliberately do NOT use the saved y. Stored y values are not guaranteed
// to be a consistent packing — the built-in Org Overview's own widgets would
// overlap if y were treated as an absolute row line — so row order follows
// array order via CSS auto-placement.

const COLUMNS = 12;

export interface WidgetGridProps {
  widgets: Widget[];
  className?: string;
  /**
   * W20-16 (UX_TODO DSH-53): offered on a widget whose type no longer exists,
   * so the person who can edit the view can take it out. Omitted where the
   * viewer cannot change the layout.
   */
  onRemoveUnknown?: (widgetId: string) => void;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * CSS custom properties for one widget's placement. Pure: it reads the saved
 * layout and returns new values, so nothing on the widget can be rewritten.
 * Custom properties (not inline grid-column/grid-row) because the placement
 * has to apply only from md up, which an inline style cannot express.
 */
function placementVars(layout: Widget['layout']): CSSProperties {
  const columnStart = clampInt(layout.x, 0, COLUMNS - 1) + 1;
  return {
    '--wg-x': columnStart,
    '--wg-w': clampInt(layout.w, 1, COLUMNS + 1 - columnStart),
    '--wg-h': clampInt(layout.h, 1, COLUMNS),
  } as CSSProperties;
}

const ITEM_CLASSES = [
  'min-w-0',
  'md:[grid-column-start:var(--wg-x)]',
  'md:[grid-column-end:span_var(--wg-w)]',
  'md:[grid-row-end:span_var(--wg-h)]',
].join(' ');

export function WidgetGrid({ widgets, className = '', onRemoveUnknown }: WidgetGridProps) {
  return (
    <div
      className={`grid w-full min-w-0 grid-cols-1 gap-4 md:grid-cols-12 ${className}`}
      data-testid="widget-grid"
      style={{ gridAutoRows: 'minmax(80px, auto)' }}
    >
      {widgets.map((widget) => {
        const def = getWidget(widget.type);
        return (
          <div
            key={widget.id}
            className={ITEM_CLASSES}
            style={placementVars(widget.layout)}
            data-testid={`widget-${widget.type}-${widget.id}`}
            data-x={widget.layout.x}
            data-y={widget.layout.y}
            data-w={widget.layout.w}
            data-h={widget.layout.h}
          >
            {def ? (
              <def.component widget={widget} />
            ) : (
              // W20-16 (UX_TODO DSH-53): said in words, with the raw type
              // kept small for whoever reports it, and a way to remove it.
              <WidgetFrame title="Widget no longer available" state="ready">
                <div
                  className="flex flex-col gap-2 text-sm"
                  data-testid={`unknown-widget-${widget.id}`}
                >
                  <p className="text-fg-muted">
                    This view has a widget this version of RepoPulse does not have (it was renamed
                    or retired). Nothing is shown in its place.{' '}
                    <span className="font-mono text-xs text-fg-faint">{widget.type}</span>
                  </p>
                  {onRemoveUnknown ? (
                    <button
                      type="button"
                      className="self-start rounded-sm border border-border px-2 py-0.5 text-xs"
                      data-testid={`remove-unknown-${widget.id}`}
                      onClick={() => onRemoveUnknown(widget.id)}
                    >
                      Remove it from this view
                    </button>
                  ) : (
                    <p className="text-xs text-fg-faint">The view&rsquo;s owner can remove it.</p>
                  )}
                </div>
              </WidgetFrame>
            )}
          </div>
        );
      })}
    </div>
  );
}
