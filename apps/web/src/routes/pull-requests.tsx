import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState } from '../components/index.js';
import { useApiQuery } from '../api/useApiQuery.js';

// The rail's "Pull Requests" destination — the ORG-WIDE list (UX_SPEC §4.c).
//
// This screen used to be a repo picker, and the reason was sound: no endpoint
// returned an org-wide list, and fanning one request per repo out of the
// browser is an N+1 against the NFR-3 p95 <500ms budget that degrades silently
// as repo count grows. W4-16 added GET /prs, so the picker is gone and the
// screen reads ONE workspace-scoped, cursor-paginated query.

export const Route = createFileRoute('/pull-requests')({
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

const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

function PullRequestsIndex() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);

  const [state, setState] = useState('');
  const [size, setSize] = useState('');
  const [author, setAuthor] = useState('');
  const [flags, setFlags] = useState<{ stale: boolean; unreviewed: boolean }>({
    stale: false,
    unreviewed: false,
  });
  // One cursor of history, not an accumulating list: paging forward replaces
  // the page. An infinite-append list here would keep growing while the filters
  // above it changed, so the rows on screen would no longer all match them.
  const [cursor, setCursor] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgPrPage>({
    endpoint: '/prs',
    query: {
      ...(state ? { state } : {}),
      ...(size ? { size_bucket: size } : {}),
      ...(author.trim() ? { author: author.trim() } : {}),
      ...(flags.stale ? { stale: 'true' } : {}),
      ...(flags.unreviewed ? { unreviewed: 'true' } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });

  const items = data?.items ?? [];

  /** Any filter change resets paging — a cursor from the old query means nothing. */
  function applied<T>(setter: (v: T) => void) {
    return (value: T) => {
      setCursor(null);
      setter(value);
    };
  }

  return (
    <div className="flex flex-col gap-4" data-testid="org-pr-list">
      <div className="flex flex-wrap items-end gap-3" data-testid="pr-filters">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          State
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="pr-filter-state"
            value={state}
            onChange={(e) => applied(setState)(e.target.value)}
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
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="pr-filter-size"
            value={size}
            onChange={(e) => applied(setSize)(e.target.value)}
          >
            <option value="">Any</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Author
          <input
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="pr-filter-author"
            value={author}
            placeholder="login"
            onChange={(e) => applied(setAuthor)(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="pr-filter-stale"
            checked={flags.stale}
            onChange={(e) => {
              setCursor(null);
              setFlags((f) => ({ ...f, stale: e.target.checked }));
            }}
          />
          Stale
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="pr-filter-unreviewed"
            checked={flags.unreviewed}
            onChange={(e) => {
              setCursor(null);
              setFlags((f) => ({ ...f, unreviewed: e.target.checked }));
            }}
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
        <table className="w-full text-sm">
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
      </WidgetFrame>

      {/* Only rendered when the server says there IS another page. A "next"
          button that is always present teaches people it sometimes lies. */}
      {data?.next_cursor && (
        <div>
          <button
            type="button"
            className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="pr-next-page"
            onClick={() => setCursor(data.next_cursor)}
          >
            Next page
          </button>
        </div>
      )}
    </div>
  );
}
