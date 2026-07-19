// HealthBadge (UX §2.1 health ramp): 3 bands only — good ≥75, watch 50–74,
// attend <50 (signals, not grades). The numeric score is ALWAYS shown next to
// the color so the band is never carried by color alone (UX §7 a11y).

export type HealthBand = 'good' | 'watch' | 'attend';

export function healthBand(score: number): HealthBand {
  if (score >= 75) return 'good';
  if (score >= 50) return 'watch';
  return 'attend';
}

const BAND_LABEL: Record<HealthBand, string> = {
  good: 'healthy',
  watch: 'watch',
  attend: 'needs attention',
};

const BAND_CLASS: Record<HealthBand, string> = {
  good: 'bg-health-good/15 text-health-good',
  watch: 'bg-health-watch/15 text-health-watch',
  attend: 'bg-health-attend/15 text-health-attend',
};

export interface HealthBadgeProps {
  /** 0–100, or null when not yet computed. */
  score: number | null;
  className?: string;
}

export function HealthBadge({ score, className = '' }: HealthBadgeProps) {
  if (score === null) {
    return (
      <span
        className={`inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 text-fg-faint tabular-nums ${className}`}
        aria-label="health score not yet computed"
        data-testid="health-badge"
        data-band="none"
      >
        —
      </span>
    );
  }
  const band = healthBand(score);
  const rounded = Math.round(score);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-sm font-medium tabular-nums ${BAND_CLASS[band]} ${className}`}
      aria-label={`health score ${rounded} of 100, ${BAND_LABEL[band]}`}
      data-testid="health-badge"
      data-band={band}
    >
      {rounded}
    </span>
  );
}
