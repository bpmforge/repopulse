import { useState } from 'react';
import { HealthBadge } from '../../components/index.js';
import type { RepoDetail } from './contracts.js';

// Health score + "why?" breakdown (UX_SPEC §1.4, FR-INSIGHTS-2/3).
//
// Principle 4, "signals, not grades": the score is never shown bare. The basis
// label ships alongside it — "Tier-1 only" means whole axes have not been
// measured yet, and a viewer who cannot see that will read a partial score as a
// verdict. The breakdown is disclosure, not decoration.

interface Props {
  health: RepoDetail['health'];
}

export function HealthWhy({ health }: Props) {
  const [open, setOpen] = useState(false);
  const axes = health.breakdown;

  return (
    <div className="relative flex items-center gap-2" data-testid="health-why">
      <HealthBadge score={health.score} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // The control names what it discloses; "why?" alone is meaningless to a
        // screen reader arriving at it out of context.
        aria-label={`Why is the health score ${health.score}? Show the formula breakdown`}
        className="rounded-sm text-xs text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="health-why-toggle"
      >
        why?
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-10 mt-2 w-72 rounded-md border border-border bg-surface p-3 shadow-sm"
          data-testid="health-why-popover"
        >
          <p className="mb-2 text-xs text-fg-muted">
            Basis: <span data-testid="health-basis">{health.basis}</span>
          </p>
          {axes.length === 0 ? (
            <p className="text-xs text-fg-muted">No sub-scores computed yet for this window.</p>
          ) : (
            <dl className="flex flex-col gap-1">
              {axes.map((axis) => (
                <div key={axis.key} className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="capitalize text-fg-muted">{axis.key.replace(/_/g, ' ')}</dt>
                  {/* Contribution is what actually moved the score; normalized
                      and weight are shown so the arithmetic is checkable rather
                      than asserted (UX_SPEC 1.4). */}
                  <dd className="tabular-nums">
                    {Math.round(axis.normalized)} x {axis.weight} = {axis.contribution.toFixed(1)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
