import { Link } from '@tanstack/react-router';
import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  formatHours,
  toStages,
  totalChurn,
  type PrDetail as PrDetailResponse,
} from './contracts.js';
import {
  SEVERITY_LABEL,
  VERIFY_LABEL,
  locationOf,
  type Finding,
} from '../findings/contracts.js';

// PR Detail (UX_SPEC §4.c): stage timeline, review feed, checks summary, and the
// files list with links into the file drill-down.

interface Props {
  repoId: string;
  number: string;
  search: Record<string, string>;
}

type FileRow = PrDetailResponse['files'][number];

const CHECK_SEVERITY: Record<string, 'low' | 'high'> = { success: 'low', failure: 'high' };

export function PrDetailScreen({ repoId, number, search }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<PrDetailResponse>({
    endpoint: '/repos/{id}/prs/{number}',
    path: { id: repoId, number },
  });

  // This PR's automated review (W16-46). The panel below was hardcoded to
  // `state="empty"` with a sentence about wave W6 arriving — no request behind
  // it — so a PR that HAD been reviewed said it had not.
  const {
    data: findings,
    isLoading: findingsLoading,
    isError: findingsIsError,
    error: findingsError,
    refetch: refetchFindings,
  } = useApiQuery<{ items: Finding[] }>({
    endpoint: '/findings',
    query: { repo_id: repoId, pr_number: number },
  });
  const reviewItems = findings?.items ?? [];

  const state = frameState({ isLoading, isError, isEmpty: false });

  if (!data) {
    return (
      <WidgetFrame
        title="Pull request"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
      />
    );
  }

  // Computed once per render rather than per stage, so every elapsed stage is
  // measured against the same instant.
  const stages = toStages(data, Date.now());

  const fileColumns: DataTableColumn<FileRow>[] = [
    {
      id: 'path',
      header: 'File',
      cell: (row) => (
        <Link
          to="/repos/$repoId/files/$"
          params={{ repoId, _splat: row.path } as never}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {row.path}
        </Link>
      ),
    },
    { id: 'type', header: 'Change', cell: (row) => row.change_type },
    {
      id: 'churn',
      header: 'Churn',
      align: 'right',
      sortable: true,
      cell: (row) => (
        <span className="tabular-nums">
          +{row.additions} −{row.deletions}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="pr-detail">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold" data-testid="pr-title">
          #{data.number} {data.title}
        </h1>
        <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs" data-testid="pr-state">
          {data.state}
        </span>
        <span className="text-xs text-fg-muted" data-testid="pr-size">
          {data.size_bucket} · {totalChurn(data.files)} lines
        </span>
      </header>

      <WidgetFrame title="Stage timeline" state="ready">
        <ol className="flex flex-col gap-2" data-testid="pr-stages">
          {stages.map((stage) => (
            <li key={stage.label} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-fg-muted">{stage.label}</span>
              <span
                className={`tabular-nums ${stage.elapsed ? 'text-warn motion-safe:animate-pulse' : ''}`}
                // Reduced motion is honoured by motion-safe: the pulse is a
                // nice-to-have signal, and UX_SPEC §4.c requires the static
                // rendering to carry the same information — which the value
                // itself already does.
                data-testid={stage.elapsed ? 'pr-stage-elapsed' : undefined}
              >
                {formatHours(stage.hours)}
              </span>
            </li>
          ))}
        </ol>
      </WidgetFrame>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <WidgetFrame
          title="Review activity"
          state={data.reviews.length === 0 ? 'empty' : 'ready'}
          emptyMessage="No reviews recorded — this PR was never reviewed."
        >
          <ul className="flex flex-col gap-1 text-sm" data-testid="pr-reviews">
            {data.reviews.map((r) => (
              <li key={`${r.reviewer}:${r.submitted_at}`} className="flex justify-between gap-3">
                <span>{r.reviewer}</span>
                <span className="text-fg-muted">
                  {r.state} · {r.submitted_at.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </WidgetFrame>

        <WidgetFrame
          title="Checks"
          state={data.checks.length === 0 ? 'empty' : 'ready'}
          emptyMessage="No CI checks reported for this PR."
        >
          <ul className="flex flex-col gap-1 text-sm" data-testid="pr-checks">
            {data.checks.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3">
                <span className="truncate">{c.name}</span>
                <SeverityBadge severity={CHECK_SEVERITY[c.conclusion ?? ''] ?? 'info'} />
              </li>
            ))}
          </ul>
        </WidgetFrame>
      </div>

      <WidgetFrame
        title="Files"
        state={data.files.length === 0 ? 'empty' : 'ready'}
        emptyMessage="No file changes ingested for this PR."
      >
        <div data-testid="pr-files">
          <DataTable
            name="pr-files"
            columns={fileColumns}
            data={data.files}
            getRowId={(row) => row.path}
          />
        </div>
      </WidgetFrame>

      <WidgetFrame
        title="Automated review"
        state={frameState({
          isLoading: findingsLoading,
          isError: findingsIsError,
          isEmpty: findings !== undefined && reviewItems.length === 0,
        })}
        {...(findingsError ? { errorMessage: findingsError.message, error: findingsError } : {})}
        onRetry={() => void refetchFindings()}
        // FR-WEB-8: say WHY there is nothing, and what would change it. An empty
        // panel with no policy line reads as "nothing found" — the opposite of
        // "not yet analysed". Kept, minus the claim that the feature has not
        // shipped: the reason a given PR has no review is scheduling and opt-in,
        // not the wave it was built in.
        emptyMessage="No automated review recorded for this pull request. Tier-2 diff review runs on a schedule per repo; Tier-3 deep review is opt-in per repo."
      >
        <table className="w-full text-sm" data-testid="pr-automated-review">
          <caption className="sr-only">Automated review findings for this pull request</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Severity</th>
              <th scope="col">Finding</th>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Verification</th>
            </tr>
          </thead>
          <tbody>
            {reviewItems.map((f) => (
              <tr key={f.id} className="border-t border-border">
                {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                <td className="py-1 whitespace-nowrap">
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
                </td>
                <th scope="row" className="py-1 text-left font-normal">
                  {/* Triage lives on the repo's Findings tab; this panel
                      reports rather than duplicating the actions. */}
                  <Link
                    to="/repos/$repoId/findings"
                    params={{ repoId }}
                    search={(prev: Record<string, unknown>) => ({ ...prev, finding: f.id })}
                    className="text-accent hover:underline"
                  >
                    {f.title}
                  </Link>
                </th>
                <td className="py-1 font-mono text-xs">{locationOf(f)}</td>
                <td className="py-1 text-xs">{f.status.replace('_', ' ')}</td>
                <td className="py-1 text-xs whitespace-nowrap">{VERIFY_LABEL[f.verify_status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>
    </div>
  );
}
