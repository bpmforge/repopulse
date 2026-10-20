import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WidgetFrame, frameState } from './WidgetFrame.js';
import { WidgetGrid } from './WidgetGrid.js';
import { getWidget, listWidgets } from './WidgetRegistry.js';
import type { Widget } from './types.js';

describe('frameState mapping', () => {
  it('prefers syncing over loading, then error, loading, empty, ready', () => {
    expect(frameState({ isLoading: true, isError: false, isEmpty: false, isSyncing: true })).toBe(
      'syncing',
    );
    expect(frameState({ isLoading: false, isError: true, isEmpty: false })).toBe('error');
    expect(frameState({ isLoading: true, isError: false, isEmpty: false })).toBe('loading');
    expect(frameState({ isLoading: false, isError: false, isEmpty: true })).toBe('empty');
    expect(frameState({ isLoading: false, isError: false, isEmpty: false })).toBe('ready');
  });
});

describe('WidgetFrame state machine (UX §4)', () => {
  it('error state shows the message, request id, and a working retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <WidgetFrame
        title="Cycle time"
        state="error"
        errorMessage="Upstream failed"
        requestId="req-abc"
        onRetry={onRetry}
      />,
    );
    const frame = screen.getByTestId('widget-frame');
    expect(frame).toHaveAttribute('data-state', 'error');
    expect(screen.getByTestId('widget-state-error')).toHaveTextContent('Upstream failed');
    expect(screen.getByTestId('widget-state-error')).toHaveTextContent('req-abc');
    await user.click(screen.getByTestId('widget-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('syncing state shows the backfill chip and marks aria-busy', () => {
    render(<WidgetFrame title="Health" state="syncing" syncPhase="history" syncPct={42} />);
    const frame = screen.getByTestId('widget-frame');
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('widget-state-syncing')).toHaveTextContent(
      'backfilling — 42% (history)',
    );
  });

  it('empty state shows the explanation', () => {
    render(<WidgetFrame title="PRs" state="empty" emptyMessage="No PRs in this window." />);
    expect(screen.getByTestId('widget-state-empty')).toHaveTextContent('No PRs in this window.');
  });
});

describe('WidgetRegistry + WidgetGrid', () => {
  it('registers the text widget', () => {
    expect(getWidget('text')).toBeDefined();
    expect(listWidgets().some((w) => w.type === 'text')).toBe(true);
  });

  it('renders a registered widget and falls back for an unregistered type', () => {
    const widgets: Widget[] = [
      { id: 'w1', type: 'text', layout: { x: 0, y: 0, w: 4, h: 2 }, options: { text: 'hello' } },
      { id: 'w2', type: 'treemap', layout: { x: 4, y: 0, w: 8, h: 4 } },
    ];
    const { unmount } = render(<WidgetGrid widgets={widgets} />);
    expect(screen.getByTestId('widget-grid')).toBeInTheDocument();
    expect(screen.getByTestId('widget-text-w1')).toHaveTextContent('hello');
    // W20-16 (UX_TODO DSH-53): in words, with a Remove for whoever may edit.
    expect(screen.getByTestId('widget-treemap-w2')).toHaveTextContent(/no longer available/i);
    expect(screen.getByTestId('widget-treemap-w2')).toHaveTextContent(/owner can remove it/);
    unmount();
    const removed: string[] = [];
    render(<WidgetGrid widgets={widgets} onRemoveUnknown={(id) => removed.push(id)} />);
    fireEvent.click(screen.getByTestId('remove-unknown-w2'));
    expect(removed).toEqual(['w2']);
  });
});

// W17-15. The grid places widgets with CSS only and treats the saved layout as
// read-only input: a value the clamp has to change for DISPLAY must still be
// reported verbatim on the data attributes, and the Widget[] handed in must
// come back out untouched. jsdom loads no stylesheet, so these assert the
// class/attribute contract; that the classes emit real CSS is a build concern.
describe('WidgetGrid placement (W17-15)', () => {
  // x + w overflows 12 and h exceeds the clamp ceiling, so every stored number
  // here differs from what placement uses — the only shape in which "raw values
  // preserved" is a real assertion rather than a tautology.
  const OUT_OF_RANGE: Widget[] = [
    { id: 'w1', type: 'text', layout: { x: 8, y: 7, w: 8, h: 20 }, options: { text: 'hi' } },
  ];

  it('echoes the stored x/y/w/h verbatim even when placement clamps them', () => {
    render(<WidgetGrid widgets={OUT_OF_RANGE} />);
    const item = screen.getByTestId('widget-text-w1');
    expect(item).toHaveAttribute('data-x', '8');
    expect(item).toHaveAttribute('data-y', '7');
    expect(item).toHaveAttribute('data-w', '8');
    expect(item).toHaveAttribute('data-h', '20');
    // Display-side: column 9 with only 4 columns left, height capped at 12.
    const style = item?.getAttribute('style') ?? '';
    expect(style).toContain('--wg-x: 9');
    expect(style).toContain('--wg-w: 4');
    expect(style).toContain('--wg-h: 12');
  });

  it('does not mutate the widgets it was given', () => {
    const widgets: Widget[] = structuredClone(OUT_OF_RANGE);
    const before = structuredClone(widgets);
    render(<WidgetGrid widgets={widgets} />);
    expect(widgets).toEqual(before);
  });

  it('stacks below md and uses the 12-col grid from md up', () => {
    render(<WidgetGrid widgets={OUT_OF_RANGE} />);
    const grid = screen.getByTestId('widget-grid');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('md:grid-cols-12');
    const item = screen.getByTestId('widget-text-w1');
    // Placement is md-and-up only; at 390px the item is a plain full-width row.
    expect(item?.className).toContain('md:[grid-column-start:var(--wg-x)]');
    expect(item?.className).toContain('md:[grid-column-end:span_var(--wg-w)]');
    expect(item?.className).toContain('md:[grid-row-end:span_var(--wg-h)]');
  });
});
