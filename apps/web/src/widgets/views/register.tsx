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
import { SEVERITY_LABEL, locationOf, type Finding } from '../findings/contracts.js';

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
} {
  const options = widget.options ?? {};
  return {
    window: typeof options.window === 'string' ? options.window : '30d',
    metricKey: typeof options.metric_key === 'string' ? options.metric_key : 'M5',
  };
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
  title: 'Waiting on my review',
  category: 'personal',
  defaultSize: { w: 6, h: 2 },
  component: () => {
    const { data, isLoading, isError, error, refetch } = useApiQuery<ReviewQueue>({
      endpoint: '/me/review-queue',
    });
    const items = data?.items ?? [];
    return (
      <WidgetFrame
        title="Waiting on my review"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="Nothing is waiting on your review."
      >
        <ul data-testid="widget-my-queue">
          {items.map((item) => (
            <PrRow
              key={`${item.repo.id}-${item.number}`}
              repoId={item.repo.id}
              number={item.number}
              title={item.title}
              repo={item.repo.name}
              meta={`${item.author} · ${formatAge(item.opened_at, Date.now())}`}
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
      query: { status: 'open' },
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
        <table className="w-full text-sm" data-testid="widget-finding-table">
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
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
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
    const { window, metricKey } = optionsOf(widget);
    const { data, isLoading, isError, error, refetch } = useApiQuery<{
      points: { computed_at: string; value: number | null }[];
      basis_label: string | null;
    }>({
      endpoint: '/metrics/series',
      query: { metric_key: metricKey, window },
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
        title={`${metricKey} trend`}
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="Fewer than two snapshots in this window — a single point is not a trend."
      >
        <Chart
          testId="widget-trend"
          ariaLabel={`${metricKey} trend, last ${window}`}
          height={180}
          tableData={{
            columns: ['Computed at', 'Value'],
            rows: points.map((p) => [p.computed_at.slice(0, 10), p.value ?? '—']),
          }}
          option={{
            grid: { left: 44, right: 12, top: 16, bottom: 28 },
            xAxis: { type: 'category', data: points.map((p) => p.computed_at.slice(0, 10)) },
            yAxis: { type: 'value' },
            tooltip: { trigger: 'axis' },
            series: [{ type: 'line', data: points.map((p) => p.value), smooth: true }],
          }}
        />
      </WidgetFrame>
    );
  },
});
