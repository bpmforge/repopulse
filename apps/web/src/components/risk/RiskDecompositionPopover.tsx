import { useState } from 'react';
import type { RiskFactors } from '../../widgets/risk/contracts.js';

// Risk decomposition popover (W9-11, RISK_MODEL.md §2 honesty rules).
//
// The arithmetic, shown. effective_risk decides what a team works on next, and
// a number nobody can take apart is a number people either obey or ignore —
// both worse than one they can argue with.
//
// It multiplies the SERVED factors rather than re-deriving them, so what the
// reader sees is what the engine stored. If those ever disagreed, this popover
// would be the thing that revealed it.

export function RiskDecompositionPopover({
  factors,
  effectiveRisk,
  severity,
  testId,
}: {
  factors: RiskFactors | null;
  effectiveRisk: number | null;
  severity: number;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center gap-1">
      <span className="tabular-nums" data-testid={`${testId ?? 'risk'}-score`}>
        {effectiveRisk === null ? 'not priced' : effectiveRisk.toFixed(2)}
      </span>
      {/* Raw severity next to every risk number, always (§2 honesty rules). */}
      <span className="text-xs text-fg-muted" data-testid={`${testId ?? 'risk'}-severity`}>
        sev {severity}
      </span>
      {factors && (
        <button
          type="button"
          className="rounded-sm border border-border px-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-expanded={open}
          data-testid={`${testId ?? 'risk'}-why`}
          onClick={() => setOpen((v) => !v)}
        >
          why?
        </button>
      )}
      {open && factors && (
        <div
          className="absolute left-0 top-full z-10 mt-1 w-72 panel p-2 text-xs shadow"
          data-testid={`${testId ?? 'risk'}-popover`}
        >
          <p className="mb-1">
            100 × {factors.H.toFixed(2)} (hazard) × {factors.L.toFixed(2)} (likelihood) ×{' '}
            {factors.X.toFixed(2)} (exposure) ={' '}
            <strong>{(100 * factors.H * factors.L * factors.X).toFixed(2)}</strong>
          </p>
          <dl className="flex flex-col gap-0.5">
            {Object.entries(factors.inputs).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-fg-muted">{key}</dt>
                <dd className="truncate">
                  {/* A null input is printed as "not measured" rather than
                      omitted: an absent row would read as though the factor
                      did not apply. */}
                  {value === null || value === undefined ? 'not measured' : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-fg-muted">model {factors.model_version}</p>
        </div>
      )}
    </span>
  );
}
