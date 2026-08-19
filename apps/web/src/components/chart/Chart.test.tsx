import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the echarts module (jsdom has no canvas) — assert the wrapper's contract,
// not pixels: init once, dispose on unmount, reduced-motion honored, table view.
const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() };
const initChart = vi.fn((..._args: unknown[]) => chart);
vi.mock('./echarts.js', () => ({
  initChart: (...args: unknown[]) => initChart(...args),
}));

// jsdom lacks ResizeObserver + matchMedia — stub them.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  initChart.mockClear();
  Object.values(chart).forEach((fn) => (fn as { mockClear: () => void }).mockClear());
});
afterEach(() => vi.unstubAllGlobals());

import { Chart } from './Chart.js';

const OPTION = { series: [{ type: 'line' as const, data: [1, 2, 3] }] };
const TABLE = { columns: ['week', 'value'], rows: [['W1', 4]] };

describe('Chart wrapper (DASHBOARD §5)', () => {
  it('initializes echarts once and sets the option with animation on', async () => {
    render(<Chart option={OPTION} ariaLabel="cycle time trend" tableData={TABLE} />);
    // await: echarts is now loaded with a dynamic import (W7-09) so it lands in
    // its own chunk instead of the entry bundle. Init is therefore a microtask
    // later than mount — the behaviour is unchanged, the timing is not.
    await vi.waitFor(() => expect(initChart).toHaveBeenCalledTimes(1));
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    expect(chart.setOption.mock.calls[0]![0]).toMatchObject({ animation: true });
  });

  it('disables animation under prefers-reduced-motion', async () => {
    (matchMedia as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    });
    render(<Chart option={OPTION} ariaLabel="cycle time trend" />);
    await vi.waitFor(() => expect(chart.setOption).toHaveBeenCalled());
    expect(chart.setOption.mock.calls[0]![0]).toMatchObject({ animation: false });
  });

  it('disposes the instance on unmount', async () => {
    const { unmount } = render(<Chart option={OPTION} ariaLabel="cycle time trend" />);
    await vi.waitFor(() => expect(initChart).toHaveBeenCalled());
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });

  it('toggles to an accessible data table (NFR-5) and back', async () => {
    const user = userEvent.setup();
    render(<Chart option={OPTION} ariaLabel="cycle time trend" tableData={TABLE} />);
    expect(screen.queryByTestId('chart-table')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('chart-table-toggle'));
    const table = screen.getByTestId('chart-table');
    expect(table).toBeInTheDocument();
    expect(table).toHaveTextContent('week');
    expect(table).toHaveTextContent('W1');

    await user.click(screen.getByTestId('chart-table-toggle'));
    expect(screen.queryByTestId('chart-table')).not.toBeInTheDocument();
  });

  it('has no view-as-table toggle when tableData is omitted', () => {
    render(<Chart option={OPTION} ariaLabel="cycle time trend" />);
    expect(screen.queryByTestId('chart-table-toggle')).not.toBeInTheDocument();
  });
});
