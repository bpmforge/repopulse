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
