import { useApiQuery } from '../../api/useApiQuery.js';
import { HEALTH_BAND_LABEL } from '../../components/primitives/HealthBadge.js';
import { axisLabel, isMeasuredAxis, type RiskAxesResponse } from './contracts.js';

// The repo-header axis strip (W10-05, RISK_MODEL.md §4, FR-RISK-6).
//
// Scores beside the health badge, each with its axis name. The rule is the one
// that governs the card: a score nobody measured is a fake score
// (FR-INSIGHTS-3), and the basis travels with the number.
//
// NO LETTERS (W20-09, UX_TODO DSH-11): this printed A–E and a screen reader
// heard "Security grade B". It is now the 0–100 sub-score with the health
// badge's band word, as UX_SPEC principle 4 and N-9 ask.
//
// At header scale the honesty was drowning itself — dashes in a row read as
// decoration, not as admissions. Measured axes keep their number inline; the
// unmeasured ones collapse behind one count that expands to the same names
// and reasons the card shows.

export function RiskAxisStrip({ repoId, window }: { repoId: string; window?: string }) {
  // W20-16 (UX_TODO DSH-82): read over the same window as the health badge.
  const { data } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: { repo_id: repoId, ...(window ? { window } : {}) },
  });

  const axes = data?.axes ?? [];
  if (axes.length === 0) return null;

  const measured = axes.filter(isMeasuredAxis);
  const unmeasured = axes.filter((a) => !isMeasuredAxis(a));

  return (
    <ul
      className="flex flex-wrap items-center gap-3 text-xs"
      data-testid="risk-axis-strip"
      aria-label={data?.window ? `Risk by axis, last ${data.window}` : 'Risk by axis'}
      title={data?.window ? `Sub-scores over the last ${data.window}` : undefined}
    >
      {measured.map((axis) => {
        const word = axis.band ? HEALTH_BAND_LABEL[axis.band] : '';
        return (
          <li key={axis.axis} className="flex items-center gap-1" title={axis.basis}>
            {/* W21-01: the axis name first and the score out of 100. "25
                Security" beside a Findings badge of 2 read as 25 security
                findings; it is a 0-100 sub-score. */}
            <span className="text-fg-muted" aria-hidden="true">
              {axisLabel(axis.axis)}
            </span>
            {/* One span for "25/100", so the row's gap does not split it. */}
            <span>
              <span
                className="font-semibold tabular-nums"
                data-testid={`axis-strip-score-${axis.axis}`}
                aria-label={`${axisLabel(axis.axis)} ${axis.score} of 100, ${word}`}
              >
                {axis.score}
              </span>
              <span className="text-fg-muted" aria-hidden="true">
                /100
              </span>
            </span>
            <span className="text-fg-muted" aria-hidden="true">
              · {word}
            </span>
            {/* Screen readers get the basis as text, not only as a tooltip. */}
            <span className="sr-only">{axis.basis}</span>
          </li>
        );
      })}

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
                {unmeasured.map((a) => axisLabel(a.axis)).join(', ')} — no sub-score for this scope,
                which is neither a good score nor a zero
              </span>
            </summary>
            {/* Floated so expanding it cannot reflow the repo header. */}
            <ul
              className="absolute right-0 z-10 mt-1 flex w-[min(16rem,calc(100vw-2rem))] flex-col sm:right-auto sm:left-0 gap-1 panel p-2"
              data-testid="axis-strip-unmeasured-list"
            >
              {unmeasured.map((axis) => (
                <li key={axis.axis} className="flex flex-col">
                  <span className="flex items-center gap-1">
                    <span
                      className="text-fg-muted"
                      data-testid={`axis-strip-score-${axis.axis}`}
                      aria-label={`${axisLabel(axis.axis)} not measured`}
                    >
                      —
                    </span>
                    <span>{axisLabel(axis.axis)}</span>
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
