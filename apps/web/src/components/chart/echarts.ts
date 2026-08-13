import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, FunnelChart, LineChart, TreemapChart } from 'echarts/charts';
import { DatasetComponent, GridComponent, TooltipComponent } from 'echarts/components';

// Register ONLY the renderers/charts/components RepoPulse uses (DASHBOARD §5
// lazy-bundle rule). Everything imports echarts through this module so the
// tree-shaken surface stays in one place (and tests mock it).
//
// W4-04 added Treemap and Funnel. The previous comment claimed "line + bar cover
// trend/histogram/funnel" — they do not: ECharts fails an unregistered series
// type at RUNTIME with a console error and draws nothing, so the repo Hotspots
// and PR Flow tabs rendered an empty box that still passed a visibility
// assertion. Any new series type must be added here.
echarts.use([
  CanvasRenderer,
  LineChart,
  BarChart,
  FunnelChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  DatasetComponent,
]);

export type EChartsInstance = ReturnType<typeof echarts.init>;
export type EChartsOption = Parameters<EChartsInstance['setOption']>[0];

export function initChart(el: HTMLElement, theme: object): EChartsInstance {
  return echarts.init(el, theme, { renderer: 'canvas' });
}
