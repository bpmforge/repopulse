import { Link } from '@tanstack/react-router';
import {
  DataTable,
  WidgetFrame,
  frameState,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { PrList as PrListResponse, PrListItem } from './contracts.js';
import { formatAge } from '../me/contracts.js';

// Repo PR list (UX_SPEC §4.c). Filters ride the URL so a filtered list is
// linkable and restores on paste (FR-WEB-2) — the same reason repo tabs are
// routes rather than local state.

interface Props {
  repoId: string;
  window: string;
  search: Record<string, string>;
  /** URL-synced list filter; undefined = all states. */
  state?: string | undefined;
  onStateChange: (next: string | undefined) => void;
  /** W20-12 (UX_TODO DSH-46): URL-synced "no review yet" filter. */
  unreviewed?: boolean;
  onUnreviewedChange?: (next: boolean) => void;
}

// Capitalised labels, lowercase API values (W20-12, UX_TODO DSH-46).
const STATES = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
] as const;

export function PrListScreen({
  repoId,
  window,
  search,
  state,
  onStateChange,
  unreviewed = false,
  onUnreviewedChange,
}: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<PrListResponse>({
    endpoint: '/repos/{id}/prs',
    path: { id: repoId },
    query: { window, ...(state ? { state } : {}), ...(unreviewed ? { unreviewed: 'true' } : {}) },
  });

  const items = data?.items ?? [];
  const now = Date.now();
  // W20-12 (UX_TODO DSH-65): say what the list covers. Open means every open
  // PR; any other filter is the PRs opened in the window.
  const allOpen = data?.scope === 'all_open' || state === 'open';

  const columns: DataTableColumn<PrListItem>[] = [
    {
      id: 'number',
      header: 'PR',
      cell: (row) => (
        <Link
          to="/repos/$repoId/prs/$number"
          params={{ repoId, number: String(row.number) }}
          search={search as never}
          className="underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid={`pr-link-${row.number}`}
        >
          #{row.number} {row.title}
        </Link>
      ),
    },
    // W20-12 (UX_TODO DSH-46): the org list's columns — who opened it, and
    // how long it has been open.
    { id: 'author', header: 'Author', cell: (row) => row.author ?? '—' },
    {
      id: 'state',
      header: 'State',
      cell: (row) => (row.is_draft && row.state === 'open' ? 'draft' : row.state),
    },
    {
      id: 'age',
      header: 'Age',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {row.opened_at && row.state === 'open' ? formatAge(row.opened_at, now) : '—'}
        </span>
      ),
    },
    { id: 'size', header: 'Size', cell: (row) => row.size_bucket },
    {
      id: 'reviewed',
      header: 'Reviewed',
      // Review coverage is the point of M5/M6, so it earns a column rather than
      // living behind a click.
      cell: (row) => (row.review_covered ? 'yes' : 'no'),
    },
  ];

  return (
    <div className="flex flex-col gap-3" data-testid="pr-list">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-fg-muted" htmlFor="pr-state-filter">
          State
        </label>
        <select
          id="pr-state-filter"
          className="panel px-2 py-1 text-sm"
          value={state ?? ''}
          onChange={(e) => onStateChange(e.target.value === '' ? undefined : e.target.value)}
          data-testid="pr-state-filter"
        >
          <option value="">All</option>
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {onUnreviewedChange && (
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={unreviewed}
              onChange={(e) => onUnreviewedChange(e.target.checked)}
              data-testid="pr-unreviewed-filter"
            />
            No review yet
          </label>
        )}
      </div>

      <WidgetFrame
        title={allOpen ? 'Pull requests — all open' : `Pull requests opened in the last ${window}`}
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No pull requests match this filter in the selected window."
      >
        <DataTable
          name="repo-prs"
          columns={columns}
          data={items}
          getRowId={(row) => String(row.number)}
        />
      </WidgetFrame>
    </div>
  );
}
