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

// FR-INSIGHTS-3 forbids a grade without its basis, and a basis that reads
// "reviewHygiene" is unreadable — which makes it the fake grade this control
// exists to prevent. Labels are therefore stated, not derived. Same shape as
// widgets/risk's AXIS_LABEL; the duplication is deliberate, the two lists name
// different things (sub-scores here, risk axes there) and drift apart.
const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  reviewHygiene: 'Review',
  ciHealth: 'CI',
  delivery: 'Delivery',
  activity: 'Activity',
  supplyChain: 'Supply Chain',
};

/**
 * Human label for a sub-score key. The fallback is what keeps a sub-score added
 * later from surfacing as a raw identifier before anyone updates the map above.
 */
export function axisLabel(key: string): string {
  const known = AXIS_LABEL[key];
  if (known) return known;
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Two decimals at most, and no trailing zeros — these sit in a narrow panel. */
function formatRaw(value: number): string {
  return String(Math.round(value * 100) / 100);
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
        // Anchored to the right edge, not the left: this trigger sits at the far
        // right of the repo header, so a left-anchored panel opened off-page and
        // the contribution numbers — the only reason to open it — were clipped
        // mid-word. The max-width makes that independent of the panel's own
        // width, so a viewport narrower than 18rem shrinks the panel instead of
        // pushing it off-screen again.
        <div
          className="absolute right-0 top-full z-10 mt-2 w-72 max-w-[calc(100vw-2rem)] panel p-3 shadow-sm"
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
                <div key={axis.key} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    {/* When space runs out the label wraps and the arithmetic does
                        not: a half-printed number is worse than a wrapped word. */}
                    <dt className="min-w-0 break-words text-fg-muted">{axisLabel(axis.key)}</dt>
                    {/* Contribution is what actually moved the score; normalized
                        and weight are shown so the arithmetic is checkable rather
                        than asserted (UX_SPEC 1.4). */}
                    <dd className="whitespace-nowrap tabular-nums">
                      {Math.round(axis.normalized)} x {axis.weight} = {axis.contribution.toFixed(1)}
                    </dd>
                  </div>

                  {/*
                    THE MEASUREMENT, not just the score (W16-21).
                    
                    Without this the panel said "Review 0 x 0.3 = 0.0" directly
                    above a chart reading 40% coverage, and both were correct:
                    reviewHygiene ramps m5 between good 0.9 and bad 0.4, so 40%
                    sits ON the bad anchor and normalises to zero. A reader had
                    no way to tell "normalised to 0" from "no reviews happened".
                    
                    The generated report already showed Raw beside Normalized;
                    this is the screen people actually look at catching up.
                  */}
                  {axis.inputs?.length ? (
                    <dd className="pl-2 text-fg-faint">
                      {axis.inputs.map((input) => (
                        <div key={input.key} className="tabular-nums">
                          {input.key} {formatRaw(input.raw)} → {Math.round(input.normalized)}
                          <span className="ml-1">
                            (best {formatRaw(input.good)}, worst {formatRaw(input.bad)})
                          </span>
                        </div>
                      ))}
                    </dd>
                  ) : null}
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
