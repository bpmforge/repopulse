import type { ReactNode } from 'react';
import { TrendDelta, type TrendPolarity } from './TrendDelta.js';

// KpiTile (UX §2.2 / §4.a): a headline metric — label, big tabular value with
// unit, and the vs-prior-window delta. The value uses tabular-nums + the KPI
// type scale (28px) so columns of numbers align (UX §2.1).

export interface KpiTileProps {
  label: string;
  /** Preformatted value (e.g. "4.1"); null renders an em dash, never "0". */
  value: string | null;
  unit?: string;
  deltaPct?: number | null;
  polarity?: TrendPolarity;
  /** Optional inline sparkline / definition link slot. */
  aside?: ReactNode;
  className?: string;
}

export function KpiTile({
  label,
  value,
  unit,
  deltaPct = null,
  polarity = 'up-good',
  aside,
  className = '',
}: KpiTileProps) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border border-border bg-surface p-4 ${className}`}
      data-testid="kpi-tile"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</span>
        {aside}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[28px] font-semibold leading-none tabular-nums text-fg">
          {value ?? '—'}
        </span>
        {unit && value !== null && <span className="text-sm text-fg-muted">{unit}</span>}
      </div>
      <TrendDelta deltaPct={deltaPct} polarity={polarity} className="text-xs" />
    </div>
  );
}
