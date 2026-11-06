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
      {/* UI-19 (UI review 2026-11-06): the label owns its own line. With the
          sparkline beside it, "Review coverage" wrapped to two lines in a
          190px tile and the chart touched the tile's top edge. The sparkline
          now sits on the value row, bottom-aligned with the number. */}
      <span className="truncate text-[13px] font-medium text-fg-muted" title={label}>
        {label}
      </span>
      <div className="flex items-end justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[30px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg">
            {value ?? '—'}
          </span>
          {unit && value !== null && <span className="text-sm text-fg-muted">{unit}</span>}
        </div>
        {/* Shrinks before the number does: at 768px with the rail open a
            tile is ~150px and a fixed 96px chart pushed <main> sideways. */}
        {aside ? (
          <div className="flex min-w-0 shrink justify-end [&>svg]:h-auto [&>svg]:max-w-full">
            {aside}
          </div>
        ) : null}
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
