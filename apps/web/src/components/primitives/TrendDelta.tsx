// TrendDelta (UX §2.2, FR-INSIGHTS-4): ▲/▼ + % change vs the prior window.
// Color encodes good/bad, but the arrow + numeric value carry the meaning too
// so color is never the sole signal (UX §7 a11y).
//
// When there is no delta we name the reason instead of drawing a glyph. A bare
// em dash collapses three different facts — never measured, never compared,
// no earlier window — into one mark that a reader cannot act on, and in audio
// it is worse still: an unlabelled dash announces as nothing at all. The same
// distinction the Security and Code Health tabs spell out in sentences.

export type TrendPolarity = 'up-good' | 'down-good' | 'neutral';

/** Why a delta is absent. Each is a different fact about the metric. */
export type MissingDeltaReason =
  /** The metric itself has no value this window, so there is nothing to compare. */
  | 'not-measured'
  /** The metric is a snapshot/count that is never compared across windows. */
  | 'not-compared'
  /** The metric is compared, but this is the earliest window we hold. */
  | 'no-prior-window';

const MISSING_TEXT: Record<MissingDeltaReason, string> = {
  'not-measured': 'not measured, so nothing to compare',
  'not-compared': 'not compared to an earlier window',
  'no-prior-window': 'no prior window to compare',
};

export interface TrendDeltaProps {
  /** Signed percent change vs prior window, or null when there is none. */
  deltaPct: number | null;
  /** Whether an increase is good, bad, or neutral for this metric. */
  polarity?: TrendPolarity;
  /** Which absence this is, when `deltaPct` is null. */
  missingReason?: MissingDeltaReason;
  className?: string;
}

function toneFor(deltaPct: number, polarity: TrendPolarity): 'ok' | 'crit' | 'neutral' {
  if (deltaPct === 0 || polarity === 'neutral') return 'neutral';
  const rising = deltaPct > 0;
  const good = polarity === 'up-good' ? rising : !rising;
  return good ? 'ok' : 'crit';
}

const TONE_CLASS = {
  ok: 'text-ok',
  crit: 'text-crit',
  neutral: 'text-fg-muted',
} as const;

export function TrendDelta({
  deltaPct,
  polarity = 'up-good',
  missingReason = 'no-prior-window',
  className = '',
}: TrendDeltaProps) {
  if (deltaPct === null) {
    const text = MISSING_TEXT[missingReason];
    return (
      <span
        // Faint and unemphasised: this is a caption under a number, not an
        // alert. It should be readable when looked for and quiet otherwise.
        className={`text-fg-faint ${className}`}
        // The label repeats the visible phrase rather than paraphrasing it, so
        // the audio and the screen say the same thing.
        aria-label={text}
        data-testid="trend-delta"
        data-trend="none"
        data-missing={missingReason}
      >
        {text}
      </span>
    );
  }

  const tone = toneFor(deltaPct, polarity);
  const arrow = deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '■';
  const magnitude = Math.abs(deltaPct);
  const formatted = `${magnitude.toFixed(magnitude < 10 ? 1 : 0)}%`;
  const dir = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat';
  // A measured zero keeps its digits on screen — the number is what makes it
  // read as a reading rather than a status — but the accessible name says
  // "unchanged" outright, because "flat 0.0%" is ambiguous when heard alone.
  const label =
    dir === 'flat'
      ? `unchanged versus prior window, ${formatted}`
      : `${dir} ${formatted} versus prior window`;

  return (
    <span
      className={`inline-flex items-center gap-0.5 tabular-nums ${TONE_CLASS[tone]} ${className}`}
      aria-label={label}
      data-testid="trend-delta"
      data-trend={dir}
    >
      <span aria-hidden="true">{arrow}</span>
      {formatted}
    </span>
  );
}
