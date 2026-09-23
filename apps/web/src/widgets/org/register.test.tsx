import { describe, expect, it } from 'vitest';
import { getWidget } from '../../components/widget/WidgetRegistry.js';
import './register.js';
import { orgWidgets } from './OrgOverview.js';

// W17-17 acceptance 3: adding the next-actions widget must not cost any of the
// registrations saved views depend on.
//
// Registration is a module SIDE EFFECT (W16-55), which is exactly the kind of
// thing a reorder can silently drop — a saved view containing a dropped type
// renders "widget is not available yet" and nothing fails until someone opens
// that view.

const EXPECTED = ['top-actions', 'kpi', 'health-grid', 'attention-feed', 'hotspot-list'] as const;

describe('org widget registrations', () => {
  it.each(EXPECTED)('registers %s', (type) => {
    expect(getWidget(type)).toBeDefined();
  });

  it('places next actions FIRST, which is what puts it above the fold', () => {
    // WidgetGrid auto-places in array order and ignores the saved `y`, so the
    // index in this array IS the position on screen. The baseline defect was
    // that the 1440x900 fold landed on the headings of Repo health and Needs
    // attention: nothing actionable was reachable without scrolling.
    const widgets = orgWidgets('30d', {});
    expect(widgets[0]?.type).toBe('top-actions');
    // Short enough that its ROWS clear the fold, not merely its title.
    expect(widgets[0]?.layout.h).toBeLessThanOrEqual(2);
    expect(widgets[0]?.layout.w).toBe(12);
  });

  it('keeps every widget the overview had before', () => {
    const types = orgWidgets('30d', {}).map((w) => w.type);
    for (const type of [
      'weekly-pulse',
      'kpi',
      'health-grid',
      'attention-feed',
      'plan-progress',
      'hotspot-list',
      'security-rollup',
      'top-risks',
      'risk-axes',
    ]) {
      expect(types).toContain(type);
    }
    // Ids stay unique — the grid keys on them.
    const ids = orgWidgets('30d', {}).map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
