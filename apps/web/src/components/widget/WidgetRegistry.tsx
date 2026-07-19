import type { ComponentType } from 'react';
import { WidgetFrame } from './WidgetFrame.js';
import type { Widget, WidgetLayout, WidgetType } from './types.js';

// WidgetRegistry (DASHBOARD §4): WidgetType → component + default layout +
// category (for the widget picker). Adding a widget type is ONE registry entry,
// no grid-engine changes. Data-driven widget types (kpi, trend, tables, …) are
// registered by the tickets that build their screens; W4-02 ships the registry
// itself + the self-contained `text` widget so the grid engine has something
// real to render.

export interface WidgetComponentProps {
  widget: Widget;
}

export type WidgetCategory = 'metrics' | 'lists' | 'personal' | 'content';

export interface WidgetDefinition {
  type: WidgetType;
  title: string;
  category: WidgetCategory;
  /** Default size in 12-col grid units when a user adds this widget. */
  defaultSize: Pick<WidgetLayout, 'w' | 'h'>;
  component: ComponentType<WidgetComponentProps>;
}

const registry = new Map<WidgetType, WidgetDefinition>();

export function registerWidget(def: WidgetDefinition): void {
  registry.set(def.type, def);
}
export function getWidget(type: WidgetType): WidgetDefinition | undefined {
  return registry.get(type);
}
export function listWidgets(): WidgetDefinition[] {
  return [...registry.values()];
}

/** Free-text note widget (no query) — the reference implementation. */
function TextWidget({ widget }: WidgetComponentProps) {
  const text = typeof widget.options?.text === 'string' ? widget.options.text : '';
  return (
    <WidgetFrame
      title={typeof widget.options?.title === 'string' ? widget.options.title : 'Note'}
      state={text ? 'ready' : 'empty'}
      emptyMessage="Empty note."
    >
      <p className="whitespace-pre-wrap text-sm text-fg">{text}</p>
    </WidgetFrame>
  );
}

registerWidget({
  type: 'text',
  title: 'Text note',
  category: 'content',
  defaultSize: { w: 4, h: 2 },
  component: TextWidget,
});
