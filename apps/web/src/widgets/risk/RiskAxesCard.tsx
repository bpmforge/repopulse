import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { RiskAxis, RiskAxesResponse } from './contracts.js';

// Risk axes (W10-05, RISK_MODEL.md §4, FR-RISK-6, FR-REG-7).
//
// A LETTER IS NEVER SHOWN WITHOUT ITS BASIS. FR-INSIGHTS-3 calls a grade
// nobody measured a fake grade, and an axis with no sub-score is exactly that
// — so an absent axis renders a dash and the sentence explaining why, never a
// letter. Hiding the row instead would be worse: the reader would not know the
// axis exists.
//
// What changed in the redesign is weight, not truth. On a fresh install every
// axis is unmeasured and the card used to repeat one sentence four times at
// hero size, which reads as a wall of noise and teaches the reader to skip the
// very sentence that matters. The unmeasured axes now collapse into one line
// that names them plus the next action, with every per-axis reason still one
// click away in the disclosure. Nothing may be dropped: the summary states the
// same fact once instead of four times.

const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  supplyChain: 'Supply Chain',
  performance: 'Performance',
};

const label = (axis: string) => AXIS_LABEL[axis] ?? axis;

/**
 * The API sets `letter` to null exactly when the sub-score is absent, so the
 * letter — not the score — is the discriminator: `score` is optional and a
 * legitimate 0 would fail a truthiness test. Nothing validates the response
 * body, so a letter that is missing or empty must fall on the unmeasured side
 * too; treating it as measured would print "grade undefined", which is the one
 * outcome this card exists to prevent.
 */
const isMeasured = (axis: RiskAxis) => typeof axis.letter === 'string' && axis.letter.length > 0;

export function RiskAxesCard({ repoId }: { repoId?: string }) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: repoId ? { repo_id: repoId } : {},
  });

  const axes = data?.axes ?? [];
  const measured = axes.filter(isMeasured);
  const unmeasured = axes.filter((a) => !isMeasured(a));
  const state = frameState({ isLoading, isError, isEmpty: axes.length === 0 });

  return (
    <WidgetFrame
      title="Risk axes"
      state={state}
      // W17-31: every failed frame offers Retry, like the rest of the overview.
      onRetry={() => void refetch()}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="No axes could be computed for this scope."
      testId="risk-axes"
    >
      <ul className="flex flex-col gap-2 text-sm" data-testid="risk-axes-list">
        {measured.map((axis) => (
          <AxisRow key={axis.axis} axis={axis} />
        ))}

        {unmeasured.length > 0 ? (
          <li className="flex flex-col gap-1" data-testid="axis-unmeasured">
            <details className="text-xs text-fg-muted">
              {/* One line, not one per axis — and it still names every axis it
                  speaks for, so an unmeasured axis is never silently absent. */}
              <summary
                className="cursor-pointer marker:text-fg-faint"
                data-testid="axis-unmeasured-summary"
              >
                Not measured: {unmeasured.map((a) => label(a.axis)).join(', ')} — no sub-score
                exists for this scope, which is neither a grade nor a zero.
              </summary>
              <ul className="mt-2 flex flex-col gap-2" data-testid="axis-unmeasured-list">
                {unmeasured.map((axis) => (
                  <AxisRow key={axis.axis} axis={axis} />
                ))}
              </ul>
            </details>

            {/* The route out of "not measured" belongs beside the admission,
                and only when there is nothing else on the card to act on. It
                names the missing input, not a missing scanner run: an axis can
                be unmeasured while findings exist (the API's second unmeasured
                basis), so any sentence about scans having run would be false
                there. Which of the two reasons applies is left to the per-axis
                basis inside the disclosure. */}
            {measured.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="axis-unmeasured-next">
                Axis letters come from a repository&rsquo;s health sub-scores; until one exists for
                this scope there is nothing to grade. Settings → Connections is where repositories
                are selected and backfilled.
              </p>
            ) : null}
          </li>
        ) : null}
      </ul>
    </WidgetFrame>
  );
}

function AxisRow({ axis }: { axis: RiskAxis }) {
  const measured = isMeasured(axis);
  return (
    <li className="flex flex-col gap-0.5" data-testid={`axis-${axis.axis}`}>
      <div className="flex items-baseline gap-2">
        <span
          className={measured ? 'w-6 text-lg font-semibold' : 'w-6 text-fg-muted'}
          data-testid={`axis-letter-${axis.axis}`}
          aria-label={
            measured
              ? `${label(axis.axis)} grade ${axis.letter}`
              : `${label(axis.axis)} not measured`
          }
        >
          {/* A dash is a placeholder, not a grade: the aria-label says so
              outright so a screen reader never reads it as one. */}
          {axis.letter ?? '—'}
        </span>
        <span className={measured ? 'font-medium' : 'text-fg-muted'}>{label(axis.axis)}</span>
        {axis.score !== null && axis.score !== undefined ? (
          <span className="text-xs text-fg-muted">{axis.score}</span>
        ) : null}
      </div>
      {/* The basis, always — beside the letter, not behind a tooltip. */}
      <span className="text-xs text-fg-muted" data-testid={`axis-basis-${axis.axis}`}>
        {axis.basis}
      </span>
      {axis.top.length > 0 ? (
        <ul className="ml-8 flex flex-col text-xs text-fg-muted">
          {axis.top.map((item) => (
            <li key={item.finding_id} className="truncate">
              {item.title}
              {item.effective_risk === null ? '' : ` · ${item.effective_risk}`}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

registerWidget({
  type: 'risk-axes',
  title: 'Risk axes',
  category: 'lists',
  defaultSize: { w: 4, h: 2 },
  component: ({ widget }) => {
    const options = widget.options ?? {};
    const repoId = typeof options.repoId === 'string' ? options.repoId : undefined;
    return <RiskAxesCard {...(repoId ? { repoId } : {})} />;
  },
});
