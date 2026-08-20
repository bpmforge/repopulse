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
//
// The work is split across four effects on purpose. A single effect keyed on
// `[option, onEvents, asTable]` disposed and re-created the instance on every
// parent render, because callers pass `option` as an inline object literal
// (RepoPulse.tsx et al) and a fresh literal is never referentially equal. Each
// teardown left the container blank until the async import resolved again, so a
// card that WidgetFrame had already flipped to 'ready' showed an empty box —
// the state the product exists to distinguish from "no data". Creation now
// depends only on what genuinely requires a new instance (theme, table toggle);
// data changes flow through setOption on the live instance instead.

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
  const [instance, setInstance] = useState<EChartsInstance | null>(null);
  // `painted` is the honest answer to "is there anything in that box yet". The
  // instance existing is not enough: echarts draws on the first setOption.
  const [painted, setPainted] = useState(false);
  const [themeKey, setThemeKey] = useState(() => activeChartTheme());
  const [asTable, setAsTable] = useState(false);

  // Re-init when data-theme flips so the token bridge picks up new colors. Kept
  // as state rather than a create() call from the observer so the re-creation
  // goes through the same effect (and the same cancellation) as the first one.
  useEffect(() => {
    const themeObserver = new MutationObserver(() => setThemeKey(activeChartTheme()));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => themeObserver.disconnect();
  }, []);

  // (Re)create the instance: on mount, on theme flip, and when returning from
  // the table view. NOT on data change — see the note at the top of the file.
  useEffect(() => {
    if (asTable) return; // table view mounted instead — no canvas needed
    const el = containerRef.current;
    if (!el) return;

    // Cancellation matters because the import is async: a component unmounted
    // mid-fetch would otherwise create a chart on a detached node and leak it.
    let cancelled = false;
    let created: EChartsInstance | null = null;

    const create = async () => {
      const { initChart } = await import('./echarts.js');
      if (cancelled || !containerRef.current) return;
      created = initChart(el, buildChartTheme());
      setInstance(created);
    };
    void create();

    return () => {
      cancelled = true;
      created?.dispose();
      setInstance(null);
      setPainted(false);
    };
  }, [asTable, themeKey]);

  // Push data into the live instance. This is also the paint signal: until it
  // has run once the container is genuinely empty, which is what the overlay
  // below covers.
  useEffect(() => {
    if (!instance) return;
    // Merge (the default), deliberately. Every caller keeps a fixed series
    // count and identity and varies only the `data` arrays, which echarts
    // replaces wholesale — so merging is correct AND lets the chart transition
    // into the new numbers instead of replaying its entrance animation on every
    // filter change. A future chart whose series COUNT varies with the data
    // would need `{ notMerge: true }` here, or the dropped series stays drawn.
    instance.setOption({ animation: !prefersReducedMotion(), ...option });
    setPainted(true);
  }, [instance, option]);

  useEffect(() => {
    if (!instance) return;
    const entries = Object.entries(onEvents ?? {});
    for (const [name, handler] of entries) instance.on(name, handler);
    return () => {
      for (const [name, handler] of entries) instance.off(name, handler);
    };
  }, [instance, onEvents]);

  useEffect(() => {
    const el = containerRef.current;
    if (!instance || !el) return;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(el);
    return () => resize.disconnect();
  }, [instance]);

  const pending = !asTable && !painted;

  return (
    <figure
      className="m-0"
      data-testid={testId}
      aria-label={ariaLabel}
      aria-busy={pending}
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
        // The container is ALWAYS rendered and always sized: echarts needs a
        // laid-out node to init into, so swapping it for a skeleton would
        // deadlock the very effect that clears the skeleton. The placeholder
        // therefore overlays it, and disappears the moment echarts has drawn.
        <div className="relative" style={{ height }}>
          <div
            ref={containerRef}
            role="img"
            aria-label={ariaLabel}
            className="h-full w-full"
            data-testid={`${testId}-canvas`}
          />
          {pending && <ChartSkeleton testId={testId} />}
        </div>
      )}
    </figure>
  );
}

/**
 * Chart-shaped placeholder for the window between "the query answered" and
 * "echarts has drawn" — mostly the first chart mount, which pays for the lazy
 * echarts chunk. It reads as "drawing", never as a result: an empty framed box
 * inside a card WidgetFrame already marked 'ready' is indistinguishable from a
 * metric with no data, and telling those apart is the whole product.
 * `motion-safe:` keeps the pulse off under prefers-reduced-motion.
 */
function ChartSkeleton({ testId }: { testId: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col justify-end gap-1.5"
      data-testid={`${testId}-pending`}
    >
      <span className="sr-only">Drawing chart…</span>
      <div className="flex h-full items-end gap-1.5" aria-hidden="true">
        {[40, 65, 30, 80, 55, 70, 45].map((pct, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-surface-2 motion-safe:animate-pulse"
            style={{ height: `${pct}%` }}
          />
        ))}
      </div>
    </div>
  );
}
