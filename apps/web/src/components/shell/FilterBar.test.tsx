import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from './FilterBar.js';
import { buildUrl } from '../../api/client.js';

// W20-09 (UX_TODO DSH-56). A pasted `start..end` window showed "7d" in the
// control and turned every card into a 400. The control now shows the dates
// and the preset the cards read, and the request carries that preset.

describe('custom window range', () => {
  it('shows the range and the preset it is read as, selected', () => {
    render(
      <FilterBar
        value={{ window: '2026-09-01..2026-09-14' }}
        onChange={vi.fn()}
        scope={{ window: true, repos: false, person: false }}
      />,
    );
    const select = screen.getByTestId('filter-window') as HTMLSelectElement;
    expect(select.value).toBe('2026-09-01..2026-09-14');
    expect(screen.getByTestId('filter-window-custom')).toHaveTextContent(
      // W20-16: a 14-day range now has a 14d preset of its own.
      '2026-09-01 → 2026-09-14 (numbers: last 14d)',
    );
  });

  it('a preset shows no custom option', () => {
    render(
      <FilterBar
        value={{ window: '90d' }}
        onChange={vi.fn()}
        scope={{ window: true, repos: false, person: false }}
      />,
    );
    expect((screen.getByTestId('filter-window') as HTMLSelectElement).value).toBe('90d');
    expect(screen.queryByTestId('filter-window-custom')).toBeNull();
  });

  it('"Custom range…" asks for two dates and applies them as start..end (W20-16)', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        value={{ window: '30d' }}
        onChange={onChange}
        scope={{ window: true, repos: false, person: false }}
      />,
    );
    fireEvent.change(screen.getByTestId('filter-window'), { target: { value: '__custom' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('filter-window-from'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByTestId('filter-window-to'), { target: { value: '2026-09-10' } });
    expect(screen.getByTestId('filter-window-range-note')).toHaveTextContent('last 14d');
    fireEvent.click(screen.getByTestId('filter-window-apply'));
    expect(onChange).toHaveBeenCalledWith({ window: '2026-09-01..2026-09-10' });
  });

  it('requests carry the covering preset, never the raw range', () => {
    expect(buildUrl('/org/summary', { query: { window: '2026-09-01..2026-09-07' } })).toBe(
      '/api/v1/org/summary?window=7d',
    );
    expect(buildUrl('/org/summary', { query: { window: '90d' } })).toBe(
      '/api/v1/org/summary?window=90d',
    );
  });
});

// W20-12 (UX_TODO DSH-63): typing is a draft; Enter, blur or a pick applies it.
describe('person filter applies on Enter, not per keystroke', () => {
  const personOnly = { window: false, repos: false, person: true };

  it('does not call onChange while typing, and does on Enter', () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ window: '30d' } as never} onChange={onChange} scope={personOnly} />);
    const input = screen.getByTestId('filter-person');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ person: 'alice' });
  });

  it('applies a picked suggestion at once, and clears on an emptied box', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        value={{ window: '30d', person: 'bob' } as never}
        onChange={onChange}
        personOptions={['alice', 'bob']}
        scope={personOnly}
      />,
    );
    const input = screen.getByTestId('filter-person');
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(onChange).toHaveBeenLastCalledWith({ person: 'alice' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ person: null });
  });
});
