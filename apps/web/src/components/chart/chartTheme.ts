// Theme-token bridge (DASHBOARD §5): ECharts colors come from the SAME Tailwind
// tokens as the UI — read as CSS custom properties off :root — so there are no
// hex literals in chart code and the chart switches with the app theme. jsdom
// doesn't compute custom properties, so every read has a hard fallback.

const FALLBACK = {
  '--color-fg': '#e6edf3',
  '--color-fg-muted': '#9da7b3',
  '--color-border': '#30363d',
  '--color-surface': '#161b22',
  '--color-accent': '#6e7bff',
  '--color-ok': '#3fb950',
  '--color-warn': '#d29922',
  '--color-info': '#58a6ff',
  '--color-crit': '#f85149',
  '--color-neutral': '#8b949e',
} as const;

function readVar(root: HTMLElement, name: keyof typeof FALLBACK): string {
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value || FALLBACK[name];
}

/** Stable 6-hue series palette (UX §2.3) — same order everywhere. */
export function chartSeriesPalette(root: HTMLElement = document.documentElement): string[] {
  return (
    [
      '--color-accent',
      '--color-ok',
      '--color-warn',
      '--color-info',
      '--color-crit',
      '--color-neutral',
    ] as const
  ).map((v) => readVar(root, v));
}

/** Mixes two hex colours; `t` is how far from `a` toward `b`. */
function mix(a: string, b: string, t: number): string {
  const parse = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

/**
 * Two-stop SEQUENTIAL ramp, for a magnitude encoding (W16-43).
 *
 * One hue, dim → bright, derived from the accent token rather than written as
 * hex so it follows the theme like everything else in this file. Deliberately
 * NOT the status palette: ok/warn/crit mean a state someone should act on, and
 * a hotspot score is a magnitude — borrowing those hues would say a file is
 * "critical" when it is merely churned.
 *
 * The low stop is mixed toward the surface only as far as it can go while
 * staying visible on it — measured at 3.06:1 against the dark surface, where
 * mixing further gave 2.18:1 and the coldest cells faded into the card.
 */
export function chartSequentialRamp(root: HTMLElement = document.documentElement): [string, string] {
  const accent = readVar(root, '--color-accent');
  return [mix(accent, readVar(root, '--color-surface'), 0.3), mix(accent, readVar(root, '--color-fg'), 0.2)];
}

/**
 * A colour from the sequential ramp for `t` in 0..1 (W16-43).
 *
 * Computed here rather than handed to ECharts as a `visualMap`, because a
 * TREEMAP ignores one: it has its own `levels`/`colorMappingBy` machinery, so
 * a global visualMap silently does nothing and every tile keeps the first
 * series colour — which is exactly the bug this replaced.
 */
export function sequentialColor(t: number, root: HTMLElement = document.documentElement): string {
  const [lo, hi] = chartSequentialRamp(root);
  return mix(lo, hi, Math.min(1, Math.max(0, t)));
}

/** Build an ECharts theme object from the active tokens (no chart-junk, UX §2.3). */
export function buildChartTheme(root: HTMLElement = document.documentElement): object {
  const fg = readVar(root, '--color-fg');
  const muted = readVar(root, '--color-fg-muted');
  const border = readVar(root, '--color-border');
  const surface = readVar(root, '--color-surface');
  const axisLine = { lineStyle: { color: border } };
  const axisLabel = { color: muted, fontSize: 12 };

  return {
    color: chartSeriesPalette(root),
    textStyle: { color: fg },
    grid: { top: 16, right: 12, bottom: 24, left: 40, containLabel: true },
    categoryAxis: {
      axisLine,
      axisLabel,
      axisTick: { show: false },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisLabel,
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
    },
    // A series VALUE LABEL is text, so it wears the ink token like every other
    // piece of text (UX §2.3). Left to itself echarts gives a bar label its own
    // default fill plus an automatic contrast STROKE, which drew the PR-funnel
    // counts as hollow outlined digits on the dark surface — legible only if
    // you already knew the number (W16-44).
    bar: { label: { color: fg, textBorderWidth: 0 } },
    // A LEGEND IS TEXT TOO (W16-46). Echarts defaults legend labels to a dark
    // grey, which on the dark surface is the background — so the file
    // drill-down drew Gross, Net and Rework as three differently coloured bars
    // with nothing on screen saying which was which. The chart looked like one
    // multicoloured series, which encodes nothing.
    legend: {
      textStyle: { color: fg },
      // The dimmed state of a legend entry someone has clicked off. Muted ink
      // rather than echarts' default, or "hidden" is itself invisible.
      inactiveColor: muted,
    },
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: fg },
    },
  };
}

/** Active theme key from the root's data-theme attribute (dark-first default). */
export function activeChartTheme(
  root: HTMLElement = document.documentElement,
): 'rp-light' | 'rp-dark' {
  return root.getAttribute('data-theme') === 'light' ? 'rp-light' : 'rp-dark';
}
