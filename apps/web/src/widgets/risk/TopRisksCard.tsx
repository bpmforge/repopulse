import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { RiskBandChip } from '../../components/risk/RiskBandChip.js';
import { RiskDecompositionPopover } from '../../components/risk/RiskDecompositionPopover.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { TopRisksResponse } from './contracts.js';

// Top Risks (W9-11, RISK_MODEL.md §5, FR-RISK-5).
//
// Five findings, ordered by what the risk engine says. The COUNTS LINE under
// them is not decoration: "200 open → 12 act" is the same credibility story as
// the CVE funnel, and a top-5 card without its denominator is a list that
// implies the other 195 do not exist.

export function TopRisksCard({ repoId }: { repoId?: string }) {
  const { data, isLoading, isError, error } = useApiQuery<TopRisksResponse>({
    endpoint: '/risk/top',
    query: repoId ? { repo_id: repoId } : {},
  });

  const items = data?.items ?? [];
  const state = frameState({ isLoading, isError, isEmpty: items.length === 0 });

  return (
    <WidgetFrame
      title="Top risks"
      state={state}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="No priced findings yet. Findings are priced by the nightly job — an empty card here means nothing has been scanned or nothing has been priced, not that there is no risk."
      testId="top-risks"
    >
      <ol className="flex flex-col gap-2 text-sm" data-testid="top-risks-list">
        {items.map((item) => (
          <li key={item.finding_id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <RiskBandChip band={item.risk_band} testId={`risk-band-${item.finding_id}`} />
              <Link
                to="/findings"
                search={{ open: item.finding_id } as never}
                className="truncate underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`top-risk-${item.finding_id}`}
              >
                {item.title}
              </Link>
            </div>
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <span>
                {item.repo.org}/{item.repo.name}
                {item.file ? ` · ${item.file}` : ''}
              </span>
              <RiskDecompositionPopover
                factors={item.risk_factors}
                effectiveRisk={item.effective_risk}
                severity={item.severity}
                testId={`risk-${item.finding_id}`}
              />
            </div>
          </li>
        ))}
      </ol>

      {data && (
        <p className="mt-2 text-xs text-fg-muted" data-testid="top-risks-counts">
          {data.counts.open} open findings → {data.counts.act} act, {data.counts.schedule}{' '}
          schedule, {data.counts.track} track
          {/* Unpriced is called out rather than folded into `track`, which
              would claim the nightly job had judged them low risk. */}
          {data.counts.unpriced > 0 ? `, ${data.counts.unpriced} not yet priced` : ''}
        </p>
      )}
    </WidgetFrame>
  );
}

registerWidget({
  type: 'top-risks',
  title: 'Top risks',
  category: 'lists',
  defaultSize: { w: 6, h: 2 },
  component: ({ widget }) => {
    const options = widget.options ?? {};
    const repoId = typeof options.repoId === 'string' ? options.repoId : undefined;
    return <TopRisksCard {...(repoId ? { repoId } : {})} />;
  },
});
