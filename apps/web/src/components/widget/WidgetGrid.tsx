import { WidgetFrame } from './WidgetFrame.js';
import { getWidget } from './WidgetRegistry.js';
import type { Widget } from './types.js';

// WidgetGrid (DASHBOARD §4): renders Widget[] on a 12-col CSS grid — the SAME
// engine for the built-in Org Overview and user-defined saved views (they
// differ by config, not code). Static render here; drag/resize edit mode
// (@dnd-kit) is layered on by the saved-views editing ticket. An unregistered
// type degrades to a placeholder frame instead of crashing the whole grid.

export interface WidgetGridProps {
  widgets: Widget[];
  className?: string;
}

export function WidgetGrid({ widgets, className = '' }: WidgetGridProps) {
  return (
    <div
      className={`grid grid-cols-12 gap-4 ${className}`}
      data-testid="widget-grid"
      style={{ gridAutoRows: 'minmax(80px, auto)' }}
    >
      {widgets.map((widget) => {
        const def = getWidget(widget.type);
        const style = {
          gridColumn: `span ${Math.min(Math.max(widget.layout.w, 1), 12)}`,
          gridRow: `span ${Math.max(widget.layout.h, 1)}`,
        };
        return (
          <div key={widget.id} style={style} data-testid={`widget-${widget.type}-${widget.id}`}>
            {def ? (
              <def.component widget={widget} />
            ) : (
              <WidgetFrame
                title={widget.type}
                state="empty"
                emptyMessage={`"${widget.type}" widget is not available yet.`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
