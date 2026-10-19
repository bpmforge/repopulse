import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { HEALTH_BAND_LABEL } from '../../components/primitives/HealthBadge.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { InternalLink } from '../plans/InternalLink.js';
import { reposParam, withRepos } from '../scopeRepos.js';
import { axisLabel, isMeasuredAxis, type RiskAxis, type RiskAxesResponse } from './contracts.js';

// Risk axes (W10-05, RISK_MODEL.md §4, FR-RISK-6, FR-REG-7).
//
// A SCORE IS NEVER SHOWN WITHOUT ITS BASIS. FR-INSIGHTS-3 calls a score nobody
// measured a fake one, and an axis with no sub-score is exactly that — so an
// absent axis renders a dash and the sentence explaining why. Hiding the row
// instead would be worse: the reader would not know the axis exists.
//
// NO LETTERS (W20-09, UX_TODO DSH-11). Each axis was an A–E grade and a screen
// reader heard "Security grade B", against UX_SPEC principle 4 and N-9. An
// axis is now its 0–100 sub-score and the health badge's band word.
//
// ORG-WIDE IS MEASURED (W20-09, UX_TODO DSH-72). On the Overview every axis
// read "not measured" in every workspace, because the API computed nothing
// without a repo_id. It now rolls the repositories up (median, with the
// lowest named), the next-step sentence comes from the real reason, and each
// contributing finding links to the finding.
//
// What did not change is weight: unmeasured axes collapse into one line that
// names them, with every per-axis reason one click away in the disclosure.

export function RiskAxesCard({ repoId, repos }: { repoId?: string; repos?: string | undefined }) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: repoId ? { repo_id: repoId } : withRepos({}, repos),
  });

  const axes = data?.axes ?? [];
  const measured = axes.filter(isMeasuredAxis);
  const unmeasured = axes.filter((a) => !isMeasuredAxis(a));
  const state = frameState({ isLoading, isError, isEmpty: axes.length === 0 });
  // The next step follows from WHY nothing is measured (DSH-72): no
  // repositories at all is a connection question; repositories that nothing
  // has examined is a scanner question. "Admin → Connections" was the answer
  // to both, and wrong for the common one.
  const noRepos = data?.repos_in_scope === 0;

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
                Not measured: {unmeasured.map((a) => axisLabel(a.axis)).join(', ')} — no sub-score
                exists for this scope, which is neither a good score nor a zero.
              </summary>
              <ul className="mt-2 flex flex-col gap-2" data-testid="axis-unmeasured-list">
                {unmeasured.map((axis) => (
                  <AxisRow key={axis.axis} axis={axis} />
                ))}
              </ul>
            </details>

            {measured.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="axis-unmeasured-next">
                {noRepos ? (
                  <>
                    No repositories are tracked in this scope yet.{' '}
                    <InternalLink to="/admin" className="text-accent hover:underline">
                      Select repositories in Settings → Connections
                    </InternalLink>
                    .
                  </>
                ) : (
                  <>
                    Axis scores come from the security and code-health sub-scores, which exist once
                    a scanner or analysis run has examined a repository. Run a scan from a
                    repository&rsquo;s Security tab.
                  </>
                )}
              </p>
            ) : null}
          </li>
        ) : null}
      </ul>
    </WidgetFrame>
  );
}

function AxisRow({ axis }: { axis: RiskAxis }) {
  const measured = isMeasuredAxis(axis);
  const word = axis.band ? HEALTH_BAND_LABEL[axis.band] : null;
  return (
    <li className="flex flex-col gap-0.5" data-testid={`axis-${axis.axis}`}>
      <div className="flex items-baseline gap-2">
        <span
          className={measured ? 'w-8 text-lg font-semibold tabular-nums' : 'w-8 text-fg-muted'}
          data-testid={`axis-score-${axis.axis}`}
          aria-label={
            measured
              ? `${axisLabel(axis.axis)} ${axis.score} of 100, ${word}`
              : `${axisLabel(axis.axis)} not measured`
          }
        >
          {/* A dash is a placeholder, not a score: the aria-label says so
              outright so a screen reader never reads it as one. */}
          {measured ? axis.score : '—'}
        </span>
        <span className={measured ? 'font-medium' : 'text-fg-muted'}>{axisLabel(axis.axis)}</span>
        {word ? (
          <span className="text-xs text-fg-muted" data-testid={`axis-band-${axis.axis}`}>
            {word}
          </span>
        ) : null}
      </div>
      {/* The basis, always — beside the score, not behind a tooltip. */}
      <span className="text-xs text-fg-muted" data-testid={`axis-basis-${axis.axis}`}>
        {axis.basis}
      </span>
      {axis.top.length > 0 ? (
        <ul className="ml-10 flex flex-col text-xs text-fg-muted">
          {axis.top.map((item) => (
            <li key={item.finding_id} className="truncate">
              {/* To the finding itself (DSH-72), not plain text. */}
              <InternalLink
                to="/findings"
                search={{ finding: String(item.finding_id) }}
                className="text-accent hover:underline"
                testId={`axis-finding-${item.finding_id}`}
              >
                {item.title}
              </InternalLink>
              {item.effective_risk === null ? '' : ` · risk ${item.effective_risk}`}
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
    const repos = reposParam(options.search as Record<string, string> | undefined);
    return <RiskAxesCard {...(repoId ? { repoId } : { repos })} />;
  },
});
