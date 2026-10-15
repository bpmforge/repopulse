// @vitest-environment node
// Node, not jsdom: jsdom has no canvas, and ECharts' server-side SVG renderer
// measures text without one only when there is no DOM canvas to reach for.
import { describe, expect, it, vi } from 'vitest';
import * as echarts from 'echarts';
import { buildChartTheme } from './chartTheme.js';

// Rendered for real (server-side SVG) rather than asserting on the theme
// object: what matters is where ECharts puts the legend once our theme is
// merged with its own defaults, and those defaults changed in ECharts 6.
function legendLabelY(theme: object): number[] {
  const chart = echarts.init(null, theme, { renderer: 'svg', ssr: true, width: 600, height: 220 });
  chart.setOption({
    // The file churn chart's layout: room for the legend above the grid.
    grid: { left: 48, right: 12, top: 24, bottom: 32 },
    legend: { data: ['Gross', 'Net'] },
    xAxis: { type: 'category', data: ['w1', 'w2'] },
    yAxis: { type: 'value' },
    series: [
      { name: 'Gross', type: 'bar', data: [3, 4] },
      { name: 'Net', type: 'bar', data: [1, 2] },
    ],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return [...svg.matchAll(/translate\([\d.]+ ([\d.]+)\)"[^>]*>(?:Gross|Net)</g)].map((m) =>
    Number(m[1]),
  );
}

describe('buildChartTheme', () => {
  it('keeps the legend at the top edge, above the grid, not on the x-axis labels', () => {
    // No stylesheet in node: every token read falls back to its default.
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const ys = legendLabelY(buildChartTheme({} as HTMLElement));
    vi.unstubAllGlobals();
    expect(ys).toHaveLength(2);
    for (const y of ys) expect(y).toBeLessThan(24);
  });
});
