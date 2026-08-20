import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { RiskAxesResponse } from './contracts.js';

// Risk axes (W10-05, RISK_MODEL.md §4, FR-RISK-6, FR-REG-7).
//
// A LETTER IS NEVER SHOWN WITHOUT ITS BASIS. FR-INSIGHTS-3 calls a grade
// nobody measured a fake grade, and an axis with no sub-score is exactly that
// — so an absent axis renders a dash and the sentence explaining why, in the
// same row, at the same size. Hiding the row instead would be worse: the
// reader would not know the axis exists.

const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  supplyChain: 'Supply Chain',
  performance: 'Performance',
};

export function RiskAxesCard({ repoId }: { repoId?: string }) {
  const { data, isLoading, isError, error } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: repoId ? { repo_id: repoId } : {},
  });

  const axes = data?.axes ?? [];
  const state = frameState({ isLoading, isError, isEmpty: axes.length === 0 });

  return (
    <WidgetFrame
      title="Risk axes"
      state={state}
      {...(error ? { errorMessage: error.message } : {})}
      emptyMessage="No axes could be computed for this scope."
      testId="risk-axes"
    >
      <ul className="flex flex-col gap-2 text-sm" data-testid="risk-axes-list">
        {axes.map((axis) => (
          <li key={axis.axis} className="flex flex-col gap-0.5" data-testid={`axis-${axis.axis}`}>
            <div className="flex items-baseline gap-2">
              <span
                className="w-6 text-lg font-semibold"
                data-testid={`axis-letter-${axis.axis}`}
                aria-label={
                  axis.letter
                    ? `${AXIS_LABEL[axis.axis] ?? axis.axis} grade ${axis.letter}`
                    : `${AXIS_LABEL[axis.axis] ?? axis.axis} not measured`
                }
              >
                {axis.letter ?? '—'}
              </span>
              <span className="font-medium">{AXIS_LABEL[axis.axis] ?? axis.axis}</span>
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
        ))}
      </ul>
    </WidgetFrame>
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
