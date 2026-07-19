// Sparkline (UX §2.3): 96×28 inline SVG — no axes, no dots, last-point marker,
// area fill at 10% opacity. Deliberately NOT the ECharts wrapper: inline SVG
// keeps chart JS out of list/table routes (DASHBOARD §5 lazy-bundle goal) and
// renders in jsdom. Always carries an aria-label so the trend isn't purely
// visual (UX §7).

export interface SparklineProps {
  points: number[];
  /** Screen-reader description, e.g. "cycle time, last 30 days". */
  label: string;
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  points,
  label,
  width = 96,
  height = 28,
  className = '',
}: SparklineProps) {
  if (points.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        className={className}
        role="img"
        aria-label={`${label}: not enough data`}
        data-testid="sparkline"
      />
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (i: number) => pad + (i / (points.length - 1)) * innerW;
  const y = (v: number) => pad + (1 - (v - min) / span) * innerH;

  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${height - pad} L${x(0)},${height - pad} Z`;
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1]!);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={label}
      data-testid="sparkline"
    >
      <path d={area} fill="var(--color-accent)" fillOpacity={0.1} stroke="none" />
      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
      <circle cx={lastX} cy={lastY} r={2} fill="var(--color-accent)" />
    </svg>
  );
}
