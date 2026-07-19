// TrendDelta (UX §2.2, FR-INSIGHTS-4): ▲/▼ + % change vs the prior window.
// Color encodes good/bad, but the arrow + numeric value carry the meaning too
// so color is never the sole signal (UX §7 a11y). `null` delta (no prior
// window) renders a muted em dash, never a fake 0%.

export type TrendPolarity = 'up-good' | 'down-good' | 'neutral';

export interface TrendDeltaProps {
  /** Signed percent change vs prior window, or null when there is no prior. */
  deltaPct: number | null;
  /** Whether an increase is good, bad, or neutral for this metric. */
  polarity?: TrendPolarity;
  className?: string;
}

function toneFor(deltaPct: number, polarity: TrendPolarity): 'ok' | 'crit' | 'neutral' {
  if (deltaPct === 0 || polarity === 'neutral') return 'neutral';
  const rising = deltaPct > 0;
  const good = polarity === 'up-good' ? rising : !rising;
  return good ? 'ok' : 'crit';
}

const TONE_CLASS = {
  ok: 'text-[--color-ok]',
  crit: 'text-[--color-crit]',
  neutral: 'text-[--color-fg-muted]',
} as const;

export function TrendDelta({ deltaPct, polarity = 'up-good', className = '' }: TrendDeltaProps) {
  if (deltaPct === null) {
    return (
      <span
        className={`tabular-nums text-[--color-fg-faint] ${className}`}
        aria-label="no prior window to compare"
        data-testid="trend-delta"
        data-trend="none"
      >
        —
      </span>
    );
  }

  const tone = toneFor(deltaPct, polarity);
  const arrow = deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '■';
  const magnitude = Math.abs(deltaPct);
  const formatted = `${magnitude.toFixed(magnitude < 10 ? 1 : 0)}%`;
  const dir = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat';

  return (
    <span
      className={`inline-flex items-center gap-0.5 tabular-nums ${TONE_CLASS[tone]} ${className}`}
      aria-label={`${dir} ${formatted} versus prior window`}
      data-testid="trend-delta"
      data-trend={dir}
    >
      <span aria-hidden="true">{arrow}</span>
      {formatted}
    </span>
  );
}
