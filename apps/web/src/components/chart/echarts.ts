import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart, TreemapChart } from 'echarts/charts';
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';

// Register ONLY the renderers/charts/components RepoPulse uses (DASHBOARD §5
// lazy-bundle rule). Everything imports echarts through this module so the
// tree-shaken surface stays in one place (and tests mock it).
//
// W4-04 added Treemap and Funnel. The previous comment claimed "line + bar cover
// trend/histogram/funnel" — they do not: ECharts fails an unregistered series
// type at RUNTIME with a console error and draws nothing, so the repo Hotspots
// and PR Flow tabs rendered an empty box that still passed a visibility
// assertion. Any new series type must be added here.
//
// FunnelChart was dropped again once the PR funnel became a bar chart: an
// ECharts funnel band's bottom edge is the NEXT stage's value, so it cannot
// draw a stage whose width is that stage's own number. Nothing renders a
// funnel now, and a registration nobody uses is dead weight in the bundle.
//
// THE SAME TRAP CATCHES COMPONENTS, not only series (W16-46). LegendComponent
// was missing, so the file drill-down's `legend: { data: ['Gross','Net',
// 'Rework'] }` was accepted and silently discarded: three differently coloured
// bar series with nothing on screen saying which was which, which reads as one
// multicoloured series encoding nothing. It failed in both themes, which is
// what ruled out a colour cause. Any chart option that names a component
// belongs in this list.
echarts.use([
  CanvasRenderer,
  LineChart,
  BarChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  DatasetComponent,
  LegendComponent,
]);

export type EChartsInstance = ReturnType<typeof echarts.init>;
export type EChartsOption = Parameters<EChartsInstance['setOption']>[0];

export function initChart(el: HTMLElement, theme: object): EChartsInstance {
  return echarts.init(el, theme, { renderer: 'canvas' });
}
