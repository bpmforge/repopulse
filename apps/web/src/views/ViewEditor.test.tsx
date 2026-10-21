import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Widget } from '../components/widget/types.js';
import '../widgets/views/register.js';
import { ViewEditor, nextColumn } from './ViewEditor.js';

// W20-20 (UX_TODO DSH-47): new widgets sit beside the last one when they fit,
// the start column can be set by hand, and Remove can be undone.

const w = (id: string, x: number, width: number): Widget =>
  ({ id, type: 'weekly-pulse', layout: { x, y: 0, w: width, h: 2 } }) as Widget;

describe('nextColumn', () => {
  it('places beside the last widget when it fits, otherwise on a new row', () => {
    expect(nextColumn([], 6)).toBe(0);
    expect(nextColumn([w('a', 0, 6)], 6)).toBe(6);
    expect(nextColumn([w('a', 0, 6), w('b', 6, 6)], 6)).toBe(0);
    expect(nextColumn([w('a', 0, 8)], 6)).toBe(0);
  });
});

function Harness({ initial, spy }: { initial: Widget[]; spy: (w: Widget[]) => void }) {
  const [widgets, setWidgets] = useState(initial);
  return (
    <ViewEditor
      widgets={widgets}
      onChange={(next) => {
        spy(next);
        setWidgets(next);
      }}
    />
  );
}

describe('ViewEditor placement and undo', () => {
  it('sets the start column from a 1-12 control', () => {
    const spy = vi.fn();
    render(<Harness initial={[w('a', 0, 6)]} spy={spy} />);
    fireEvent.change(screen.getByTestId('column-a'), { target: { value: '7' } });
    expect(spy.mock.lastCall?.[0][0].layout.x).toBe(6);
  });

  it('undoes a remove, back in its place', () => {
    const spy = vi.fn();
    render(<Harness initial={[w('a', 0, 6), w('b', 6, 6), w('c', 0, 12)]} spy={spy} />);
    fireEvent.click(screen.getByTestId('remove-b'));
    expect(screen.queryByTestId('edit-widget-b')).toBeNull();
    fireEvent.click(screen.getByTestId('undo-remove'));
    expect(spy.mock.lastCall?.[0].map((x: Widget) => x.id)).toEqual(['a', 'b', 'c']);
    expect(screen.queryByTestId('undo-remove')).toBeNull();
  });
});
