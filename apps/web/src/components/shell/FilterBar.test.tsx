import { render, screen } from '@testing-library/react';
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
      '2026-09-01 → 2026-09-14 (as 30d)',
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

  it('requests carry the covering preset, never the raw range', () => {
    expect(buildUrl('/org/summary', { query: { window: '2026-09-01..2026-09-07' } })).toBe(
      '/api/v1/org/summary?window=7d',
    );
    expect(buildUrl('/org/summary', { query: { window: '90d' } })).toBe(
      '/api/v1/org/summary?window=90d',
    );
  });
});
