import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState, PageHeader } from '../components/index.js';
import { useApiQuery } from '../api/useApiQuery.js';

// The rail's "Pull Requests" destination — the ORG-WIDE list (UX_SPEC §4.c).
//
// This screen used to be a repo picker, and the reason was sound: no endpoint
// returned an org-wide list, and fanning one request per repo out of the
// browser is an N+1 against the NFR-3 p95 <500ms budget that degrades silently
// as repo count grows. W4-16 added GET /prs, so the picker is gone and the
// screen reads ONE workspace-scoped, cursor-paginated query.

const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const STATES = ['open', 'merged', 'closed'] as const;

export interface PrListSearch {
  state?: (typeof STATES)[number];
  size?: (typeof SIZES)[number];
  stale?: true;
  unreviewed?: true;
  cursor?: string;
}

/**
 * The list's filters and page, in the URL (W20-05, UX_TODO DSH-13; FR-WEB-2).
 *
 * They lived in component state, so Back from a pull request reset them and a
 * filtered list could not be linked. Lenient like the other screens' search
 * validators: a junk value is dropped, never a white screen.
 */
export function validatePrListSearch(search: Record<string, unknown>): PrListSearch {
  const out: PrListSearch = {};
  if ((STATES as readonly unknown[]).includes(search.state)) out.state = search.state as never;
  if ((SIZES as readonly unknown[]).includes(search.size)) out.size = search.size as never;
  if (search.stale === true || search.stale === 'true') out.stale = true;
  if (search.unreviewed === true || search.unreviewed === 'true') out.unreviewed = true;
  if (typeof search.cursor === 'string' && search.cursor.length > 0) out.cursor = search.cursor;
  return out;
}

/** The global topbar csv as the API's repo_id csv; `all` means no filter. */
export function repoIdParam(repos: string | undefined): string | undefined {
  return repos && repos !== 'all' ? repos : undefined;
}

export const Route = createFileRoute('/pull-requests')({
  validateSearch: validatePrListSearch,
  component: PullRequestsIndex,
});

interface OrgPr {
  number: number;
  title: string;
  author: string;
  repo: { id: number; org: string; name: string };
  size_bucket: string;
  state: string;
  opened_at: string;
  review_covered: boolean;
}

interface OrgPrPage {
  items: OrgPr[];
  next_cursor: string | null;
}

function PullRequestsIndex() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/pull-requests' });
  const preserved = serializeGlobalSearch(search);
  const { state, size, stale, unreviewed, cursor } = search;

  /**
   * Any filter change drops the cursor — a cursor from the old query means
   * nothing. One cursor of history, not an accumulating list: paging forward
   * replaces the page, so every row on screen matches the filters above it.
   * The topbar's repo/person changes rebuild the search from the global keys
   * alone (mergeGlobalSearch), so they drop the cursor too.
   */
  const setFilter = (patch: { [K in keyof PrListSearch]?: PrListSearch[K] | undefined }) =>
    void navigate({
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        delete next.cursor;
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
        return next as never;
      },
    });

  // REPOSITORY AND PERSON COME FROM THE TOPBAR (W16-50). This screen used to
  // carry its own Author box beside the global person filter — two controls for
  // one question, of which only the local one worked. The global pair now
  // narrows this list, and the duplicate is gone rather than kept in sync.
  //
  // `repos` goes over as a CSV (DSH-13): the API parsed it as one integer, so
  // a two-repository selection was a 400.
  const repoIds = repoIdParam(search.repos);
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgPrPage>({
    endpoint: '/prs',
    query: {
      ...(repoIds ? { repo_id: repoIds } : {}),
      ...(search.person ? { author: search.person } : {}),
      ...(state ? { state } : {}),
      ...(size ? { size_bucket: size } : {}),
      ...(stale ? { stale: 'true' } : {}),
      ...(unreviewed ? { unreviewed: 'true' } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="org-pr-list">
      <PageHeader
        title="Pull Requests"
        description="Every pull request across the connected repositories."
      />
      <div className="flex flex-wrap items-end gap-3" data-testid="pr-filters">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          State
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="pr-filter-state"
            value={state ?? ''}
            onChange={(e) =>
              setFilter({ state: (e.target.value || undefined) as PrListSearch['state'] })
            }
          >
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Size
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="pr-filter-size"
            value={size ?? ''}
            onChange={(e) =>
              setFilter({ size: (e.target.value || undefined) as PrListSearch['size'] })
            }
          >
            <option value="">Any</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="pr-filter-stale"
            checked={stale === true}
            onChange={(e) => setFilter({ stale: e.target.checked ? true : undefined })}
          />
          Stale
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="pr-filter-unreviewed"
            checked={unreviewed === true}
            onChange={(e) => setFilter({ unreviewed: e.target.checked ? true : undefined })}
          />
          Unreviewed
        </label>
      </div>

      <WidgetFrame
        title="Pull requests"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No pull requests match these filters."
      >
        {/* W18-28: scrolls inside its own region at phone width instead of
            squeezing every column until the headers run together. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Pull requests">
          <table className="table-plain w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Pull requests across every connected repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Repository</th>
                <th scope="col">PR</th>
                <th scope="col">Author</th>
                <th scope="col">Size</th>
                <th scope="col">State</th>
                <th scope="col">Reviewed</th>
              </tr>
            </thead>
            <tbody data-testid="org-pr-rows">
              {items.map((pr) => (
                <tr key={`${pr.repo.id}-${pr.number}`} className="border-t border-border">
                  <td className="py-1">{pr.repo.name}</td>
                  <th scope="row" className="py-1 text-left font-normal">
                    <Link
                      to="/repos/$repoId/prs/$number"
                      params={{ repoId: String(pr.repo.id), number: String(pr.number) }}
                      search={preserved as never}
                      className="text-accent hover:underline"
                    >
                      #{pr.number} {pr.title}
                    </Link>
                  </th>
                  <td className="py-1">{pr.author}</td>
                  <td className="py-1 tabular-nums">{pr.size_bucket}</td>
                  <td className="py-1">{pr.state}</td>
                  {/* Paired mark + text: never colour alone (WCAG, UX_SPEC §7). */}
                  <td className="py-1">{pr.review_covered ? '✓ yes' : '— no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>

      {/* Only rendered when the server says there IS another page. A "next"
          button that is always present teaches people it sometimes lies. */}
      {data?.next_cursor && (
        <div>
          <button
            type="button"
            className="panel-inset px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="pr-next-page"
            onClick={() =>
              void navigate({
                search: (prev: Record<string, unknown>) =>
                  ({ ...prev, cursor: data.next_cursor }) as never,
              })
            }
          >
            Next page
          </button>
        </div>
      )}
    </div>
  );
}
