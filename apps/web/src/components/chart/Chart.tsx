import { useEffect, useRef, useState } from 'react';
// TYPE-ONLY import: pulling `initChart` as a value here put echarts into the
// registry chunk, so every screen paid 175 KB gz for charts it might never
// render (W7-09). The runtime import happens inside the effect below, which
// gives echarts its own chunk fetched on first chart mount.
import type { EChartsInstance, EChartsOption } from './echarts.js';
import { activeChartTheme, buildChartTheme } from './chartTheme.js';

// The one ECharts wrapper (DASHBOARD §5). Owns init/dispose, container resize
// (ResizeObserver), the theme-token bridge, canvas renderer, reduced-motion,
// re-init on app theme change, and the mandatory "view as table" toggle (the
// accessible data alternative, NFR-5 / UX §2.3). No chart variant touches
// echarts directly — they compose an `option` and hand it here.

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A row for the accessible table fallback (headers + string cells). */
export interface ChartTableData {
  columns: string[];
  rows: (string | number)[][];
}

export interface ChartProps {
  option: EChartsOption;
  /** Accessible name for the chart region (required — UX §7). */
  ariaLabel: string;
  /** Data for the "view as table" fallback; toggle hidden if omitted. */
  tableData?: ChartTableData;
  onEvents?: Record<string, (params: unknown) => void>;
  height?: number;
  testId?: string;
}

export function Chart({
  option,
  ariaLabel,
  tableData,
  onEvents,
  height = 240,
  testId = 'chart',
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<EChartsInstance | null>(null);
  const [asTable, setAsTable] = useState(false);

  // (Re)create the instance on mount and whenever the app theme flips.
  useEffect(() => {
    if (asTable) return; // table view mounted instead — no canvas needed
    const el = containerRef.current;
    if (!el) return;

    // Cancellation matters because the import is async: a component unmounted
    // mid-fetch would otherwise create a chart on a detached node and leak it.
    let cancelled = false;

    const create = async () => {
      const { initChart } = await import('./echarts.js');
      if (cancelled || !containerRef.current) return;
      instanceRef.current?.dispose();
      const chart = initChart(el, buildChartTheme());
      instanceRef.current = chart;
      chart.setOption({ animation: !prefersReducedMotion(), ...option });
      for (const [name, handler] of Object.entries(onEvents ?? {})) chart.on(name, handler);
    };
    void create();

    const resize = new ResizeObserver(() => instanceRef.current?.resize());
    resize.observe(el);

    // Re-init when data-theme flips so the token bridge picks up new colors.
    const themeObserver = new MutationObserver(() => void create());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      cancelled = true;
      resize.disconnect();
      themeObserver.disconnect();
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [option, onEvents, asTable]);

  return (
    <figure
      className="m-0"
      data-testid={testId}
      aria-label={ariaLabel}
      data-theme-key={activeChartTheme()}
    >
      <div className="flex justify-end">
        {tableData && (
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="rounded-sm px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg"
            data-testid="chart-table-toggle"
            aria-pressed={asTable}
          >
            {asTable ? 'View as chart' : 'View as table'}
          </button>
        )}
      </div>
      {asTable && tableData ? (
        <table className="w-full text-sm tabular-nums" data-testid="chart-table">
          <thead>
            <tr>
              {tableData.columns.map((c) => (
                <th key={c} className="border-b border-border px-2 py-1 text-left text-fg-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableData.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="border-b border-border px-2 py-1 text-fg">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div
          ref={containerRef}
          role="img"
          aria-label={ariaLabel}
          style={{ height }}
          data-testid={`${testId}-canvas`}
        />
      )}
    </figure>
  );
}
