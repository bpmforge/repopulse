import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { AiGovernance, AiGovernanceMeasure, MeContext } from './contracts.js';

// AI-authored vs human changes (W18-20) — the org tile.
//
// It RENDERS the server's comparison and decides nothing: the cohorts, the
// minimum samples and the direction words all come from
// packages/metrics/src/authorship/governance.ts, so the tile and the report
// cannot disagree about whether a sample was big enough.
//
// SIGNALS, NOT GRADES (N-9): no colour says good or bad, no letter, no ranking,
// no person. A direction is a word ("higher for AI"), and a measure below its
// minimum sample says so in place of a direction.

interface Props {
  window: string;
  search: Record<string, string>;
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

function value(m: AiGovernanceMeasure, v: number | null): string {
  if (v === null) return '—';
  return m.unit === 'ratio' ? pct(v) : v.toFixed(2);
}

function comparison(m: AiGovernanceMeasure): string {
  if (!m.comparable || m.direction === null) return 'too small to compare';
  return m.direction === 'similar' ? 'similar' : `${m.direction} for AI`;
}

export function AiGovernanceCard({ window, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<AiGovernance>({
    endpoint: '/org/ai-governance',
    // `person` is deliberately NOT forwarded: the endpoint is aggregate-only.
    query: { window, ...(search.repos ? { repos: search.repos } : {}) },
  });

  // The patterns link is an admin's tool; a member is not shown a door that
  // opens onto a 403.
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  const classified = data ? data.counts.aiCommits + data.counts.humanCommits : 0;
  const state = frameState({ isLoading, isError, isEmpty: data !== undefined && classified === 0 });

  return (
    <WidgetFrame
      title="AI-authored vs human changes"
      state={state}
      onRetry={() => void refetch()}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage={
        data && data.counts.unknownCommits > 0
          ? `No change in this window could be classified yet: ${data.counts.unknownCommits} commits were ingested before authorship signals were recorded.`
          : 'No commits in this window to classify.'
      }
      testId="ai-governance"
      // W18-29: the full comparison — cohorts left out, sample sizes, method.
      drillDown={
        <Link
          to="/governance"
          search={{ ...(search.repos ? { repos: search.repos } : {}), window } as never}
          className="min-h-6 text-xs text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="ai-governance-details"
        >
          Details
        </Link>
      }
    >
      {data && classified > 0 && (
        <div className="flex flex-col gap-3 text-sm" data-testid="ai-governance-body">
          <div className="flex flex-wrap gap-6">
            <div className="flex flex-col" data-testid="ai-share-commits">
              <span className="text-xs text-fg-muted">AI-authored commits</span>
              <span className="text-lg tabular-nums">{pct(data.aiShareCommits)}</span>
              <span className="text-xs text-fg-muted tabular-nums">
                {data.counts.aiCommits} of {classified}
              </span>
            </div>
            <div className="flex flex-col" data-testid="ai-share-prs">
              <span className="text-xs text-fg-muted">AI-authored pull requests</span>
              <span className="text-lg tabular-nums">{pct(data.aiSharePrs)}</span>
              <span className="text-xs text-fg-muted tabular-nums">
                {data.counts.aiPrs} of {data.counts.aiPrs + data.counts.humanPrs}
              </span>
            </div>
          </div>

          {!data.anyComparable && (
            <p className="text-xs text-fg" data-testid="ai-governance-small-sample" role="note">
              Too small a sample to compare AI-authored and human changes in this window. Try a
              longer window.
            </p>
          )}

          <table className="w-full text-xs" data-testid="ai-governance-measures">
            <thead>
              <tr className="text-left text-fg-muted">
                <th scope="col" className="pb-1 pr-2 font-normal">
                  Measure
                </th>
                <th scope="col" className="pb-1 pr-2 text-right font-normal">
                  AI
                </th>
                <th scope="col" className="pb-1 pr-2 text-right font-normal">
                  Human
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Signal
                </th>
              </tr>
            </thead>
            <tbody>
              {data.measures.map((m) => (
                <tr
                  key={m.key}
                  className="border-t border-border"
                  data-testid={`ai-measure-${m.key}`}
                  data-comparable={m.comparable ? 'true' : 'false'}
                >
                  <th scope="row" className="py-1 pr-2 text-left font-normal" title={m.basis}>
                    {m.label}
                  </th>
                  <td className="py-1 pr-2 text-right tabular-nums">{value(m, m.ai)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{value(m, m.human)}</td>
                  <td className="py-1 text-fg-muted" title={m.note ?? undefined}>
                    {m.note?.startsWith('Not measured') ? 'not measured' : comparison(m)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-fg-muted" data-testid="ai-governance-basis">
            Signals, not grades — aggregated, never per person. From co-author trailers, agent bot
            accounts and agent branch names
            {data.counts.unknownCommits > 0
              ? `; ${data.counts.unknownCommits} older commits predate these signals and are left out`
              : ''}
            .
          </p>
          {me?.role === 'admin' && (
            <Link
              to="/admin/settings"
              search={{} as never}
              className="text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="ai-governance-patterns"
            >
              Authorship patterns
            </Link>
          )}
        </div>
      )}
    </WidgetFrame>
  );
}

registerWidget({
  type: 'ai-governance',
  title: 'AI-authored vs human changes',
  category: 'metrics',
  // Its own type: registerWidget overwrites by type (W5-07).
  defaultSize: { w: 6, h: 2 },
  component: ({ widget }) => {
    const options = widget.options ?? {};
    return (
      <AiGovernanceCard
        window={typeof options.window === 'string' ? options.window : '30d'}
        search={(options.search as Record<string, string> | undefined) ?? {}}
      />
    );
  },
});
