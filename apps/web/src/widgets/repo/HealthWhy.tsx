import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
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
  /** For the "where to act" link (W20-12, DSH-23); omitted, no link renders. */
  repoId?: string;
  search?: Record<string, string>;
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

/**
 * Each score input's name and unit (W20-12, UX_TODO DSH-23). The panel printed
 * "m5 0.4 → 0" and "stalePrCount 3": internal keys and bare fractions. `ratio`
 * values are stored 0..1 and shown as percent; `pct` are already percent.
 * Keys from packages/insights/src/score/health.ts buildHealthSubScores.
 */
type InputUnit = 'ratio' | 'pct' | 'h' | 'd' | 'count' | 'x';
const INPUT_META: Record<string, { label: string; unit: InputUnit }> = {
  commitCountVsMedian: { label: 'Commits vs. usual', unit: 'x' },
  daysSinceLastPush: { label: 'Days since last push', unit: 'd' },
  m5: { label: 'Review coverage', unit: 'ratio' },
  medianFirstReviewHours: { label: 'Median time to first review', unit: 'h' },
  stalePrCount: { label: 'Stale pull requests', unit: 'count' },
  m9PassRate: { label: 'CI pass rate', unit: 'ratio' },
  topFlakiness: { label: 'Flakiest workflow rerun rate', unit: 'ratio' },
  openFindingDensity: { label: 'Open findings (severity-weighted)', unit: 'count' },
  worstOpenSeverity: { label: 'Worst open severity (1–5)', unit: 'count' },
  duplicationPct: { label: 'Duplicated code', unit: 'pct' },
  complexityP90: { label: 'Complexity p90', unit: 'count' },
  slopDensity: { label: 'AI-slop findings density', unit: 'count' },
  rework14d: { label: 'Rework within 14 days', unit: 'ratio' },
  supplyChainRisk: { label: 'Dependency risk (weighted)', unit: 'count' },
  eolRuntimeCount: { label: 'Runtimes past end of life', unit: 'count' },
  e2eCycleP50Hours: { label: 'PR cycle time (median)', unit: 'h' },
  m11DaysSinceRelease: { label: 'Days since last release', unit: 'd' },
  m12Cfr: { label: 'Change failure rate', unit: 'ratio' },
};

/** "Review coverage", or the key split into words for an input added later. */
export function inputLabel(key: string): string {
  return INPUT_META[key]?.label ?? axisLabel(key);
}

/** A raw input value with its unit: 0.4 of a ratio reads "40%", 18 hours "18h". */
export function formatInput(key: string, value: number): string {
  switch (INPUT_META[key]?.unit) {
    case 'ratio':
      return `${formatRaw(value * 100)}%`;
    case 'pct':
      return `${formatRaw(value)}%`;
    case 'h':
      return `${formatRaw(value)}h`;
    case 'd':
      return `${formatRaw(value)}d`;
    case 'x':
      return `${formatRaw(value)}×`;
    default:
      return formatRaw(value);
  }
}

/**
 * Where a sub-score's inputs are shown in full and acted on (W20-12, DSH-23),
 * so the weakest input links somewhere instead of ending the reader's trail.
 */
const AXIS_TAB: Record<string, string> = {
  activity: '/repos/$repoId/activity',
  reviewHygiene: '/repos/$repoId/pr-flow',
  ciHealth: '/repos/$repoId/ci',
  delivery: '/repos/$repoId/activity',
  security: '/repos/$repoId/security',
  codeHealth: '/repos/$repoId/code-health',
  supplyChain: '/repos/$repoId/security',
};

/**
 * The basis in plain words (W20-12, UX_TODO DSH-19/80) — "Tier-1 only" is
 * internal vocabulary. Shared by the repo header and the Overview tiles.
 */
export function basisWords(notMeasured: readonly string[] | undefined, basis: string): string {
  if (basis === 'not measured') return 'Not measured yet';
  if (notMeasured === undefined) {
    // An older API: only the label to go on.
    return basis === 'full' ? 'Based on every measure' : 'Based on delivery data only';
  }
  if (notMeasured.length === 0) return 'Based on every measure';
  return `Based on what was measured — ${notMeasured.map(axisLabel).join(', ')} not measured`;
}

export function HealthWhy({ health, repoId, search }: Props) {
  const [open, setOpen] = useState(false);
  // Tolerates an older or partial payload with no breakdown at all — the
  // weakest-part lookup below runs on every render, not only when open.
  const axes = health.breakdown ?? [];
  const missing = health.not_measured ?? [];
  const rootRef = useRef<HTMLDivElement>(null);

  // W20-12 (UX_TODO DSH-23): Esc and a click outside close the panel, as every
  // other popover in the app does; it could only be closed by its own toggle.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  // The lowest-scoring sub-score is where effort moves the number most — the
  // "what to do" the panel never offered.
  const weakest = [...axes].sort((a, b) => a.normalized - b.normalized)[0];
  const weakestTab = weakest ? AXIS_TAB[weakest.key] : undefined;

  return (
    <div className="relative flex items-center gap-2" data-testid="health-why" ref={rootRef}>
      <HealthBadge score={health.score} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // The control names what it discloses; "why?" alone is meaningless to a
        // screen reader arriving at it out of context.
        // An unmeasured repository has no score to explain (W20-05, DSH-08);
        // "Why is the health score null?" would read the wire format aloud.
        aria-label={
          health.score === null
            ? 'Why is there no health score yet? Show what has been measured'
            : `Why is the health score ${health.score}? Show the formula breakdown`
        }
        className="inline-flex min-h-6 items-center rounded-sm px-1 text-xs text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
            <span data-testid="health-basis">
              {basisWords(
                health.not_measured?.map((m) => m.key),
                health.basis,
              )}
            </span>
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
                        // W20-12 (DSH-23): "Review coverage 40% → 0 (target
                        // 90%, worst 40%)", not "m5 0.4 → 0".
                        <div key={input.key} className="tabular-nums">
                          {inputLabel(input.key)} {formatInput(input.key, input.raw)} →{' '}
                          {Math.round(input.normalized)}
                          <span className="ml-1">
                            (target {formatInput(input.key, input.good)}, worst{' '}
                            {formatInput(input.key, input.bad)})
                          </span>
                        </div>
                      ))}
                    </dd>
                  ) : null}
                </div>
              ))}
            </dl>
          )}
          {/* W20-12 (UX_TODO DSH-80): the parts that are NOT in the score,
              and that the rest were rescaled to fill their weight. A score
              from two of seven parts read exactly like one from all seven. */}
          {missing.length > 0 && (
            <div className="mt-2 border-t border-border pt-2 text-xs" data-testid="health-missing">
              <ul className="flex flex-col gap-0.5 text-fg-muted">
                {missing.map((m) => (
                  <li key={m.key} className="flex justify-between gap-3">
                    <span>{axisLabel(m.key)}</span>
                    <span className="tabular-nums text-fg-faint">
                      not measured (would weigh {m.weight.toFixed(2)})
                    </span>
                  </li>
                ))}
              </ul>
              {health.renormalized && (
                <p className="mt-1 text-fg-faint" data-testid="health-renormalized">
                  Weights rescaled because {missing.length}{' '}
                  {missing.length === 1 ? 'part is' : 'parts are'} missing.
                </p>
              )}
            </div>
          )}
          {weakest && weakestTab && repoId && (
            <Link
              to={weakestTab as never}
              params={{ repoId } as never}
              search={(search ?? {}) as never}
              className="mt-2 inline-block text-xs text-accent underline-offset-2 hover:underline"
              data-testid="health-weakest-link"
              onClick={() => setOpen(false)}
            >
              Weakest part: {axisLabel(weakest.key)} — see {axisLabel(weakest.key)} details →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
