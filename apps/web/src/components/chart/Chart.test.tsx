import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the echarts module (jsdom has no canvas) — assert the wrapper's contract,
// not pixels: init once, dispose on unmount, reduced-motion honored, table view.
const chart = {
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};
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
// Unmount BEFORE the stubs go. echarts arrives by dynamic import, so a test
// that never awaits it (the toggle-absent one) can have its chart instance
// land after the test body; if ResizeObserver is already unstubbed by then,
// the resize effect throws into the next test. The setup file's cleanup runs
// after this hook, which is too late.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    // setOption runs in the effect AFTER the re-render that init triggers, so
    // it needs its own wait; asserting it synchronously raced that render.
    await vi.waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(1));
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

// Regression: four Pulse cards rendered as empty framed boxes for seconds. Two
// causes, both covered here — the frame flips to 'ready' before echarts has
// drawn (first mount pays for the lazy chunk), and every parent re-render used
// to dispose and re-create the instance because `option` is an inline literal.
describe('paint gap (W-FIX)', () => {
  it('keeps one instance across parent re-renders with an equal-but-new option', async () => {
    function Parent() {
      const [, force] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => force((n) => n + 1)} data-testid="rerender" />
          <Chart option={{ series: [{ type: 'line', data: [1, 2, 3] }] }} ariaLabel="trend" />
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Parent />);
    await vi.waitFor(() => expect(initChart).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('rerender'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initChart).toHaveBeenCalledTimes(1);
    expect(chart.dispose).not.toHaveBeenCalled();
  });

  it('pushes new data onto the live instance instead of re-initializing', async () => {
    const { rerender } = render(<Chart option={OPTION} ariaLabel="trend" />);
    await vi.waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(1));

    rerender(
      <Chart option={{ series: [{ type: 'line' as const, data: [9] }] }} ariaLabel="trend" />,
    );
    await vi.waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(initChart).toHaveBeenCalledTimes(1);
    expect(chart.setOption.mock.calls[1]![0]).toMatchObject({
      series: [{ type: 'line', data: [9] }],
    });
    // Merged, not replaced: the chart transitions into the new numbers rather
    // than replaying its entrance animation on every filter change.
    expect(chart.setOption.mock.calls[1]![1]).toBeUndefined();
  });

  it('shows a chart-shaped placeholder until echarts has painted, then removes it', async () => {
    render(<Chart option={OPTION} ariaLabel="trend" testId="probe" />);
    // Before the async echarts import resolves the container is genuinely empty.
    expect(screen.getByTestId('probe')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('probe-pending')).toBeInTheDocument();
    // The container is rendered and sized the whole time — echarts cannot init
    // into a node that is not there.
    expect(screen.getByTestId('probe-canvas')).toBeInTheDocument();

    await vi.waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveAttribute('aria-busy', 'false'),
    );
    expect(screen.queryByTestId('probe-pending')).not.toBeInTheDocument();
  });

  it('does not re-show the placeholder when only the data changes (stale-chart rule)', async () => {
    const { rerender } = render(<Chart option={OPTION} ariaLabel="trend" testId="probe" />);
    await vi.waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveAttribute('aria-busy', 'false'),
    );
    rerender(
      <Chart
        option={{ series: [{ type: 'line' as const, data: [7] }] }}
        ariaLabel="trend"
        testId="probe"
      />,
    );
    expect(screen.queryByTestId('probe-pending')).not.toBeInTheDocument();
  });
});
