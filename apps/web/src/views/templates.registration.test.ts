import { describe, expect, it } from 'vitest';
import { VIEW_TEMPLATES } from './templates.js';
import { getWidget, listWidgets } from '../components/widget/WidgetRegistry.js';
// Side-effect import: the same one the root route makes. Without it this file
// would be asserting against an empty registry, which is the bug itself.
import '../widgets/registerAll.js';

// W16-55. Views shipped four templates and a widget registry, and the two were
// never checked against each other. Two separate failures met here:
//
//   1. Every registration was a side-effect import reachable only through
//      OrgOverview, so loading /views directly found an EMPTY registry and each
//      tile rendered "widget is not available yet" — the whole feature, inert.
//   2. Three of the four templates named types nothing registered at all
//      (my-prs, my-queue, finding-table, trend), so even reaching them via the
//      org overview left most tiles as placeholders.
//
// A template is a promise the product makes on a screen that offers it as a
// starting point.

describe('view templates and the widget registry (W16-55)', () => {
  it('registers something at all', () => {
    // The first failure in isolation: if registerAll stops being imported, or
    // stops importing a screen's module, this is what goes first.
    expect(listWidgets().length).toBeGreaterThan(5);
  });

  it.each(VIEW_TEMPLATES.map((t) => [t.name, t] as const))(
    'every widget the "%s" template asks for is registered',
    (_name, template) => {
      for (const widget of template.widgets) {
        expect(getWidget(widget.type), `${template.id} → ${widget.type}`).toBeDefined();
      }
    },
  );

  it('every template has at least one widget', () => {
    // A template that opens an empty page is a worse starting point than none.
    for (const template of VIEW_TEMPLATES) {
      expect(template.widgets.length, template.id).toBeGreaterThan(0);
    }
  });
});
