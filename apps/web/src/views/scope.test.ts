import { describe, expect, it } from 'vitest';
import type { Widget } from '../components/widget/types.js';
import { scopeLabel, scopeWidgets } from './contracts.js';
import { configFromScreen } from './SaveAsViewButton.js';
import { orgWidgets } from '../widgets/org/OrgOverview.js';

// W20-05 — a saved view's scope reaches its widgets (UX_TODO DSH-02), and the
// Overview can be saved as a view (DSH-07).

const kpi: Widget = { id: 'k', type: 'kpi', layout: { x: 0, y: 0, w: 12, h: 1 } };

describe('scopeWidgets (DSH-02)', () => {
  it("hands every widget the view's window and repositories", () => {
    const [scoped] = scopeWidgets([kpi], '90d', [3, 4]);
    expect(scoped!.options).toEqual({ window: '90d', search: { window: '90d', repos: '3,4' } });
  });

  it("leaves a widget's own options in charge", () => {
    const pinned: Widget = { ...kpi, options: { window: '365d', metric_key: 'M9' } };
    const [scoped] = scopeWidgets([pinned], '90d', []);
    expect(scoped!.options).toMatchObject({ window: '365d', metric_key: 'M9' });
    // No repos key at all for "every repository".
    expect(scoped!.options!.search).toEqual({ window: '90d' });
  });

  it('says the scope in words', () => {
    expect(scopeLabel('90d', [])).toBe('Last 90 days · all repositories');
    expect(scopeLabel('30d', [7], { 7: 'acme/web' })).toBe('Last 30 days · acme/web');
    expect(scopeLabel('7d', [1, 2, 3, 4])).toBe('Last 7 days · 4 repositories');
  });
});

describe('Save as view from the Overview (DSH-07)', () => {
  it('captures the window, the repo filter and the layout, without pinned options', () => {
    const config = configFromScreen(orgWidgets('90d', { window: '90d' }), '90d', '7,9');
    expect(config.window).toBe('90d');
    expect(config.repo_ids).toEqual([7, 9]);
    expect(config.layout.length).toBe(orgWidgets('90d', {}).length);
    // The view's own scope drives the widgets later, not today's filter.
    expect(config.layout.every((w) => !('options' in w))).toBe(true);
  });

  it('treats `all` as every repository', () => {
    expect(configFromScreen([kpi], '30d', 'all').repo_ids).toEqual([]);
    expect(configFromScreen([kpi], '30d', undefined).repo_ids).toEqual([]);
  });
});
