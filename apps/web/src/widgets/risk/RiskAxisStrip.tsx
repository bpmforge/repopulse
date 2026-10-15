import { useApiQuery } from '../../api/useApiQuery.js';
import type { RiskAxis, RiskAxesResponse } from './contracts.js';

// The repo-header axis strip (W10-05, RISK_MODEL.md §4, FR-RISK-6).
//
// Letters beside the health grade, each with its axis name. The rule is the
// one that governs the card: a grade nobody measured is a fake grade
// (FR-INSIGHTS-3), and the basis travels with the letter.
//
// At header scale the honesty was drowning itself — four dashes in a row read
// as decoration, not as four admissions. Measured axes keep their letter
// inline; the unmeasured ones collapse behind one count that expands to the
// same names and reasons the card shows. The dash-plus-"not measured" label is
// intact inside; it is one click away instead of four times over.

const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  supplyChain: 'Supply Chain',
  performance: 'Performance',
};

const label = (axis: string) => AXIS_LABEL[axis] ?? axis;

/**
 * Null letter ⇔ absent sub-score; `score` is optional and 0 is a real value.
 * A missing or empty letter counts as unmeasured as well — nothing validates
 * the response, and "grade undefined" beside a repo name is worse than a dash.
 */
const isMeasured = (axis: RiskAxis) =>
  typeof axis.letter === 'string' && axis.letter.length > 0;

export function RiskAxisStrip({ repoId }: { repoId: string }) {
  const { data } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: { repo_id: repoId },
  });

  const axes = data?.axes ?? [];
  if (axes.length === 0) return null;

  const measured = axes.filter(isMeasured);
  const unmeasured = axes.filter((a) => !isMeasured(a));

  return (
    <ul className="flex flex-wrap items-center gap-3 text-xs" data-testid="risk-axis-strip">
      {measured.map((axis) => (
        <li key={axis.axis} className="flex items-center gap-1" title={axis.basis}>
          <span
            className="font-semibold"
            data-testid={`axis-strip-letter-${axis.axis}`}
            aria-label={`${label(axis.axis)} grade ${axis.letter}`}
          >
            {axis.letter}
          </span>
          <span className="text-fg-muted">{label(axis.axis)}</span>
          {/* Screen readers get the basis as text, not only as a tooltip. */}
          <span className="sr-only">{axis.basis}</span>
        </li>
      ))}

      {unmeasured.length > 0 ? (
        <li data-testid="axis-strip-unmeasured">
          <details className="relative">
            <summary
              className="min-h-6 cursor-pointer py-1 text-fg-muted marker:text-fg-faint"
              data-testid="axis-strip-unmeasured-summary"
            >
              {unmeasured.length} not measured
              {/* The count is the compact form; the names are what a screen
                  reader needs, since "3 not measured" alone names nothing. */}
              <span className="sr-only">
                {': '}
                {unmeasured.map((a) => label(a.axis)).join(', ')} — no sub-score for this scope,
                which is neither a grade nor a zero
              </span>
            </summary>
            {/* Floated so expanding it cannot reflow the repo header. */}
            <ul
              className="absolute left-0 z-10 mt-1 flex w-64 flex-col gap-1 panel p-2"
              data-testid="axis-strip-unmeasured-list"
            >
              {unmeasured.map((axis) => (
                <li key={axis.axis} className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span
                      className="text-fg-muted"
                      data-testid={`axis-strip-letter-${axis.axis}`}
                      aria-label={`${label(axis.axis)} not measured`}
                    >
                      —
                    </span>
                    <span>{label(axis.axis)}</span>
                  </span>
                  <span className="text-fg-muted" data-testid={`axis-strip-basis-${axis.axis}`}>
                    {axis.basis}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </li>
      ) : null}
    </ul>
  );
}
