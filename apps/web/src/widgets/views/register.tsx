import { Link } from '@tanstack/react-router';
import {
  Chart,
  WidgetFrame,
  frameState,
  registerWidget,
  type WidgetComponentProps,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { formatAge, type MyPrs, type ReviewQueue } from '../me/contracts.js';
import { locationOf, type Finding } from '../findings/contracts.js';
import { FindingSeverityBadge } from '../findings/FindingSeverity.js';
import { KPI_TILES } from '../org/contracts.js';

// The widget types the VIEW TEMPLATES ask for (W16-55).
//
// Views shipped four templates and a registry, and three of the four named
// types nothing registered — `my-prs`, `my-queue`, `finding-table` and `trend`.
// Choosing "My work" produced a page of "widget is not available yet", so the
// feature advertised four starting points and only one of them could draw.
//
// These are deliberately SMALLER than the screens they echo: a tile in a
// dashboard answers "is there anything here for me", and the full list is one
// click away. That is also why they do not reuse My Focus's tables, which are
// built inline with cross-repo identity columns for a screen where the list IS
// the content.

function optionsOf(widget: WidgetComponentProps['widget']): {
  window: string;
  metricKey: string;
  repoId: string | null;
} {
  const options = widget.options ?? {};
  return {
    window: typeof options.window === 'string' ? options.window : '30d',
    metricKey: typeof options.metric_key === 'string' ? options.metric_key : 'M5',
    // One repository's series, or the org rollup when absent (DSH-60).
    repoId: typeof options.repo_id === 'string' ? options.repo_id : null,
  };
}

/**
 * The metrics a trend widget can chart, with a human name and a unit
 * (W20-05, UX_TODO DSH-60). The same five org-rollup series the KPI row reads:
 * they are the ones the snapshot job writes with no repository, which is what
 * /metrics/series returns without a repo_id. The editor's metric picker lists
 * exactly these.
 */
export const TREND_METRICS = KPI_TILES.map(({ key, label, unit }) => ({ key, label, unit }));

/** "Review coverage", never "M5" — and an unknown key degrades to itself. */
export function trendMetric(key: string): { key: string; label: string; unit: string | undefined } {
  return TREND_METRICS.find((m) => m.key === key) ?? { key, label: key, unit: undefined };
}

/** Repo-qualified, because PR numbers restart per repository. */
function PrRow({
  repoId,
  number,
  title,
  repo,
  meta,
}: {
  repoId: number;
  number: number;
  title: string;
  repo: string;
  meta: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-2 border-t border-border py-1 text-sm first:border-t-0">
      <Link
        to="/repos/$repoId/prs/$number"
        params={{ repoId: String(repoId), number: String(number) }}
        className="min-w-0 truncate text-accent hover:underline"
      >
        #{number} {title}
      </Link>
      <span className="shrink-0 text-xs text-fg-muted">
        {repo} · {meta}
      </span>
    </li>
  );
}

registerWidget({
  type: 'my-prs',
  title: 'My pull requests',
  category: 'personal',
  defaultSize: { w: 6, h: 2 },
  component: () => {
    const { data, isLoading, isError, error, refetch } = useApiQuery<MyPrs>({
      endpoint: '/me/prs',
    });
    // OPEN only, like the tile on My Focus (W16-51): a dashboard tile answers
    // "what is on my plate", and a merged pull request is not on it.
    const items = (data?.items ?? []).filter((pr) => pr.state === 'open');
    return (
      <WidgetFrame
        title="My open pull requests"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="Nothing open — you have no pull requests in flight."
      >
        <ul data-testid="widget-my-prs">
          {items.map((pr) => (
            <PrRow
              key={`${pr.repo.id}-${pr.number}`}
              repoId={pr.repo.id}
              number={pr.number}
              title={pr.title}
              repo={pr.repo.name}
              meta={`open ${formatAge(pr.opened_at, Date.now())}`}
            />
          ))}
        </ul>
      </WidgetFrame>
    );
  },
});

registerWidget({
  type: 'my-queue',
  // W20-16 (UX_TODO DSH-85): requested reviewers are ingested, so this is
  // the PRs that ask you (plus, until their next sync, older PRs whose
  // request list is not known — marked on the row).
  title: 'Awaiting my review',
  category: 'personal',
  defaultSize: { w: 6, h: 2 },
  component: () => {
    const { data, isLoading, isError, error, refetch } = useApiQuery<ReviewQueue>({
      endpoint: '/me/review-queue',
    });
    const items = data?.items ?? [];
    return (
      <WidgetFrame
        title="Awaiting my review"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No open pull request is waiting on a review from you."
      >
        <ul data-testid="widget-my-queue">
          {items.map((item) => (
            <PrRow
              key={`${item.repo.id}-${item.number}`}
              repoId={item.repo.id}
              number={item.number}
              title={item.title}
              repo={item.repo.name}
              meta={`${item.author} · ${formatAge(item.opened_at, Date.now())}${item.requested === null ? ' · request not known yet' : ''}`}
            />
          ))}
        </ul>
      </WidgetFrame>
    );
  },
});

registerWidget({
  type: 'finding-table',
  title: 'Open findings',
  category: 'lists',
  defaultSize: { w: 12, h: 2 },
  component: () => {
    const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Finding[] }>({
      endpoint: '/findings',
      // W20-08 (UX_TODO FND-49): open + confirmed, as every "open" count means.
      query: { status: 'active' },
    });
    const items = data?.items ?? [];
    return (
      <WidgetFrame
        title="Open findings"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No open findings. Findings appear once an analysis or scanner run completes."
      >
        {/* W18-28: scrolls inside its own region at phone width instead of
            squeezing every column until the headers run together. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Open findings">
          <table
            className="table-plain w-full min-w-[40rem] text-sm"
            data-testid="widget-finding-table"
          >
            <caption className="sr-only">Open findings across every analysed repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Repository</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 10).map((f) => (
                <tr key={f.id} className="border-t border-border">
                  {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                  <td className="py-1 whitespace-nowrap">
                    <FindingSeverityBadge severity={f.severity} />
                  </td>
                  <th scope="row" className="py-1 text-left font-normal">
                    <Link
                      to="/findings"
                      search={{ finding: f.id } as never}
                      className="text-accent hover:underline"
                    >
                      {f.title}
                    </Link>
                  </th>
                  <td className="py-1 text-xs">{f.repo.name}</td>
                  <td className="py-1 font-mono text-xs">{locationOf(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>
    );
  },
});

registerWidget({
  type: 'trend',
  title: 'Metric trend',
  category: 'metrics',
  defaultSize: { w: 12, h: 2 },
  component: ({ widget }) => {
    const { window, metricKey, repoId } = optionsOf(widget);
    const metric = trendMetric(metricKey);
    // Ratios are stored 0..1 (METRICS.md); the axis says percent, so the
    // points are scaled to match it, as the KPI tiles do (formatKpi).
    const scale = metric.unit === '%' ? 100 : 1;
    const { data, isLoading, isError, error, refetch } = useApiQuery<{
      points: { computed_at: string; value: number | null }[];
      basis_label: string | null;
    }>({
      endpoint: '/metrics/series',
      query: { metric_key: metricKey, window, ...(repoId ? { repo_id: repoId } : {}) },
    });
    const points = data?.points ?? [];
    // TWO points, not one: a single dot is not a trend, and drawing one as if
    // it were is the failure the org sparklines were fixed for.
    const state = frameState({
      isLoading,
      isError,
      isEmpty: data !== undefined && points.length < 2,
    });
    return (
      <WidgetFrame
        title={`${metric.label} trend`}
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="Fewer than two snapshots in this window — a single point is not a trend."
      >
        <Chart
          testId="widget-trend"
          ariaLabel={`${metric.label} trend, last ${window}`}
          height={180}
          tableData={{
            columns: [
              'Computed at',
              metric.unit ? `${metric.label} (${metric.unit})` : metric.label,
            ],
            rows: points.map((p) => [
              p.computed_at.slice(0, 10),
              p.value === null ? '—' : Math.round(p.value * scale * 10) / 10,
            ]),
          }}
          option={{
            grid: { left: 44, right: 12, top: 24, bottom: 28 },
            xAxis: { type: 'category', data: points.map((p) => p.computed_at.slice(0, 10)) },
            // The unit on the axis (DSH-60): a bare 0.8 does not say "80%".
            yAxis: { type: 'value', ...(metric.unit ? { name: metric.unit } : {}) },
            tooltip: { trigger: 'axis' },
            series: [
              {
                type: 'line',
                name: metric.label,
                data: points.map((p) => (p.value === null ? null : p.value * scale)),
                smooth: true,
              },
            ],
          }}
        />
      </WidgetFrame>
    );
  },
});
