import { describe, expect, it } from 'vitest';
import { fromWidgets, toWidget, toWidgets } from './contracts.js';

// Saved-view layout narrowing (W5-02). The API stores layout as a loose
// Record<string, unknown>[] (W5-01 declined to pin the widget shape), so this
// boundary is where a malformed or older view has to fail safely.

describe('view layout narrowing', () => {
  it('round-trips widgets through storage unchanged', () => {
    const widgets = toWidgets({
      repo_ids: [],
      window: '30d',
      layout: [{ id: 'a', type: 'kpi', layout: { x: 0, y: 0, w: 12, h: 1 } }],
    });
    expect(fromWidgets(widgets)).toEqual([{ id: 'a', type: 'kpi', layout: { x: 0, y: 0, w: 12, h: 1 } }]);
  });

  it('SKIPS a malformed entry instead of crashing the page', () => {
    // A view saved by an older build, or hand-edited, must cost its own widget
    // — not the whole dashboard.
    expect(toWidget({ type: 'kpi' })).toBeNull();
    expect(toWidget({ id: 'x' })).toBeNull();
    expect(
      toWidgets({ repo_ids: [], window: '30d', layout: [{ nonsense: true }, { id: 'ok', type: 'kpi' }] }),
    ).toHaveLength(1);
  });

  it('defaults a missing size rather than rendering a zero-width widget', () => {
    const w = toWidget({ id: 'a', type: 'kpi' });
    expect(w?.layout.w).toBe(6);
    expect(w?.layout.h).toBe(2);
  });
});
