import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart } from 'echarts/charts';
import { DatasetComponent, GridComponent, TooltipComponent } from 'echarts/components';

// Register ONLY the renderers/charts/components RepoPulse uses (DASHBOARD §5
// lazy-bundle rule) — the canvas renderer handles 50-repo org rollups, line +
// bar cover trend/histogram/funnel. Everything imports echarts through this
// module so the tree-shaken surface stays in one place (and tests mock it).
echarts.use([
  CanvasRenderer,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  DatasetComponent,
]);

export type EChartsInstance = ReturnType<typeof echarts.init>;
export type EChartsOption = Parameters<EChartsInstance['setOption']>[0];

export function initChart(el: HTMLElement, theme: object): EChartsInstance {
  return echarts.init(el, theme, { renderer: 'canvas' });
}
