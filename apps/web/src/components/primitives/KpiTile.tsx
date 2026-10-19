import type { ReactNode } from 'react';
import {
  TrendDelta,
  type DeltaKind,
  type MissingDeltaReason,
  type TrendPolarity,
} from './TrendDelta.js';

// KpiTile (UX §2.2 / §4.a): a headline metric — label, big tabular value with
// unit, and the vs-prior-window delta. The value uses tabular-nums + the KPI
// type scale (28px) so columns of numbers align (UX §2.1).

export interface KpiTileProps {
  label: string;
  /** Preformatted value (e.g. "4.1"); null renders an em dash, never "0". */
  value: string | null;
  unit?: string;
  /**
   * Signed percent change vs the prior window. Omit it for metrics that are
   * never compared across windows (My Focus counts); pass null when the metric
   * is compared but this is the earliest window we hold. The two are different
   * facts and the caption says which.
   */
  deltaPct?: number | null;
  /** What the delta is measured in (W20-12, DSH-17/83); percent by default. */
  deltaKind?: DeltaKind;
  polarity?: TrendPolarity;
  /** A caption under the delta — the sample a ratio rests on (W20-12, DSH-81). */
  caption?: ReactNode;
  /** Optional inline sparkline / definition link slot. */
  aside?: ReactNode;
  className?: string;
}

// Order matters: a missing value outranks everything, because "no prior window"
// printed under a dashed value would explain the wrong absence — we never got a
// number this window at all, so no comparison was ever on the table.
function missingReasonFor(
  value: string | null,
  deltaPct: number | null | undefined,
): MissingDeltaReason {
  if (value === null) return 'not-measured';
  if (deltaPct === undefined) return 'not-compared';
  return 'no-prior-window';
}

export function KpiTile({
  label,
  value,
  unit,
  // Deliberately not defaulted to null: the destructure default would erase the
  // difference between "this caller does not compare windows" and "there was no
  // earlier window", which is the whole point of the caption below.
  deltaPct,
  deltaKind,
  polarity = 'up-good',
  aside,
  caption,
  className = '',
}: KpiTileProps) {
  return (
    <div className={`panel-inset flex flex-col gap-1.5 p-4 ${className}`} data-testid="kpi-tile">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">{label}</span>
        {aside}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[30px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg">
          {value ?? '—'}
        </span>
        {unit && value !== null && <span className="text-sm text-fg-muted">{unit}</span>}
      </div>
      <TrendDelta
        deltaPct={deltaPct ?? null}
        polarity={polarity}
        missingReason={missingReasonFor(value, deltaPct)}
        {...(deltaKind ? { kind: deltaKind } : {})}
        className="text-xs"
      />
      {caption}
    </div>
  );
}
