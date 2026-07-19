import { render, screen } from '@testing-library/react';
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
    render(<WidgetGrid widgets={widgets} />);
    expect(screen.getByTestId('widget-grid')).toBeInTheDocument();
    expect(screen.getByTestId('widget-text-w1')).toHaveTextContent('hello');
    expect(screen.getByTestId('widget-treemap-w2')).toHaveTextContent(/not available yet/i);
  });
});
