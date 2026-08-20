import { describe, expect, it } from 'vitest';
import { prStageChartOption, type PrStage } from './PrFlow.js';

// Regression for the PR stage chart (W4-FIX). The shipped ECharts `funnel`
// series drew its middle band from the Reviewed value out to the Merged value,
// so any repo that merges PRs without review rendered a funnel that bulged in
// the middle — a shape asserting an ordering the numbers never had. These
// assertions pin the two properties that made that possible: a bar's length is
// its own stage's value, and the value axis is never pinned to Opened.

// ECharts option objects are loosely typed by design; the chart's own tests
// mock echarts entirely, so reading the option back is the only place these
// invariants can be checked without a canvas.
type StageOption = {
  xAxis: { type: string; max?: number };
  yAxis: { data: string[]; inverse?: boolean };
  series: [{ type: string; data: number[]; label: { show: boolean; formatter: string } }];
};

function build(stages: PrStage[]): StageOption {
  return prStageChartOption(stages) as unknown as StageOption;
}

/** Stage names in the order a reader sees them, top of the chart first. */
function topToBottom(option: StageOption): string[] {
  const names = [...option.yAxis.data];
  // A category axis counts up from the bottom, so only `inverse` puts the
  // first entry on top — the array order alone proves nothing.
  return option.yAxis.inverse ? names : names.reverse();
}

const STAGES: PrStage[] = [
  { name: 'Opened', value: 40 },
  { name: 'Reviewed', value: 12 },
  { name: 'Merged', value: 31 },
];

describe('PR stage chart', () => {
  it('reaches the chart as Opened, Reviewed, Merged from the top', () => {
    expect(topToBottom(build(STAGES))).toEqual(['Opened', 'Reviewed', 'Merged']);
  });

  it('carries every stage value, paired with its stage, in the same order', () => {
    const option = build(STAGES);
    expect(option.series[0].data).toEqual([40, 12, 31]);
    expect(option.yAxis.data).toEqual(['Opened', 'Reviewed', 'Merged']);
    expect(option.series[0].type).toBe('bar');
  });

  it('prints the count on every bar so nobody estimates it from geometry', () => {
    const option = build(STAGES);
    expect(option.series[0].label.show).toBe(true);
    expect(option.series[0].label.formatter).toContain('{c}');
  });

  it('labels a zero stage rather than leaving an unexplained empty row', () => {
    // A zero-length bar with no label is exactly the "not measured looks like
    // nothing" failure the product forbids; the label carries the whole message.
    const option = build([
      { name: 'Opened', value: 4 },
      { name: 'Reviewed', value: 0 },
      { name: 'Merged', value: 0 },
    ]);
    expect(option.series[0].data).toEqual([4, 0, 0]);
    expect(option.series[0].label.show).toBe(true);
  });

  it('does not clamp a later stage that exceeds an earlier one', () => {
    // Only reachable if the counts stop being three filters of one list — bad
    // window boundaries can review a PR that was opened before the window. The
    // chart must show 51 as bigger than 40, not flatten both to full width.
    const option = build([
      { name: 'Opened', value: 40 },
      { name: 'Reviewed', value: 51 },
      { name: 'Merged', value: 31 },
    ]);
    expect(option.series[0].data).toEqual([40, 51, 31]);
    expect(option.xAxis.max).toBeUndefined();
  });

  it('keeps stage widths proportional by never using a funnel series', () => {
    // The funnel band's bottom edge is the NEXT stage's value, which is what
    // made Reviewed render wider than Opened.
    expect(build(STAGES).series[0].type).not.toBe('funnel');
  });
});
