import { useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  ErrorNote,
  WidgetFrame,
  errorToast,
  frameState,
  useUiStore,
} from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { connectionHost } from './Connections.js';
import type { ConnectionList } from './contracts.js';

// Identity admin (W5-05, FR-AUTH-4 / FR-METRICS-3).
//
// One person is many identities: a forge login plus every email address that
// authored a commit without a resolvable account (FORGE_PROVIDER §1). Left
// unmerged their churn is split, which UNDERSTATES bus-factor risk — a file
// that looks like it has two contributors may have one.
//
// Merging is deliberately manual. The API can suggest identities sharing a
// display name, but a wrong merge silently rewrites authorship on every screen,
// so a human decides.

const LIST = { endpoint: '/admin/identities' } as const;

interface Identity {
  id: number;
  provider: string;
  login: string;
  display_name: string;
  is_bot: boolean;
  merged_into_id: number | null;
  commits: number;
  prs: number;
  email_fallback: boolean;
  /** The member this committer is (W20-10, UX_TODO INS-51), or null. */
  user_id?: number | null;
  /** The survivor's login, so a page names it without loading it (W20-22). */
  merged_into_login?: string | null;
}

interface IdentityPage {
  items: Identity[];
  /** Rows matching the filters, across every page (W20-22, X-17). */
  total?: number;
  /** Every identity in the workspace. */
  all?: number;
  providers?: string[];
}

interface MemberOption {
  user_id: number;
  login: string;
  auth_provider?: string;
}

const MEMBERS = { endpoint: '/admin/members' } as const;

/**
 * Which forge an identity is on (W20-15, UX_TODO X-17). In a multi-forge
 * workspace "alice" on GitHub and "alice" on Gitea looked identical, so an
 * admin could not tell which to merge into which.
 */
export function identityLabel(
  i: Pick<Identity, 'login' | 'provider'>,
  hosts?: ReadonlyMap<string, string>,
): string {
  const host = hosts?.get(i.provider);
  return `${i.login} (${i.provider}${host ? ` · ${host}` : ''})`;
}

/**
 * The host of each forge, when the workspace has exactly one connection to it
 * (W20-22, X-17). Identities carry their forge but not their connection, so
 * with two GitHub connections the host is unknown and left off rather than
 * guessed.
 */
export function hostsByProvider(
  connections: readonly { provider: string; base_url: string | null; status: string }[],
): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const c of connections) {
    if (c.status === 'removed') continue;
    const set = seen.get(c.provider) ?? new Set<string>();
    set.add(connectionHost(c.provider, c.base_url));
    seen.set(c.provider, set);
  }
  const out = new Map<string, string>();
  for (const [provider, hosts] of seen) if (hosts.size === 1) out.set(provider, [...hosts][0]!);
  return out;
}

/** What a merge or a bot flag changes, and when (W20-22, UX_TODO ADM-70). */
export const RECOMPUTE_NOTE =
  'The file page updates now; dashboards and reports update at the next nightly recompute.';

/** The API's query for one page of the list (W20-22, X-17: paged on the server). */
export function identityQuery(f: IdentityFilter, page: number): Record<string, string> {
  return {
    ...(f.query.trim() ? { q: f.query.trim() } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.bots === 'all' ? {} : { bots: f.bots }),
    limit: String(IDENTITY_PAGE_SIZE),
    offset: String(page * IDENTITY_PAGE_SIZE),
  };
}

export const IDENTITY_PAGE_SIZE = 100;

export interface IdentityFilter {
  query: string;
  provider: string;
  bots: 'all' | 'humans' | 'bots';
}

/** Search, provider and bot filters (W20-15, X-17), applied to the full list. */
export function filterIdentities<T extends Identity>(items: readonly T[], f: IdentityFilter): T[] {
  const q = f.query.trim().toLowerCase();
  return items.filter(
    (i) =>
      (q === '' || i.login.toLowerCase().includes(q) || i.display_name.toLowerCase().includes(q)) &&
      (f.provider === '' || i.provider === f.provider) &&
      (f.bots === 'all' || (f.bots === 'bots' ? i.is_bot : !i.is_bot)),
  );
}

/**
 * "This committer is that member" (W20-10, UX_TODO INS-51).
 *
 * A local or OIDC account has no forge account, so its My Focus and "my PRs"
 * stayed empty for good while the banner told the person to "ask an
 * administrator to link your forge identity" — and nothing could. The link is
 * reversible (choose "not linked"), and the API refuses a forge account that
 * already belongs to someone else, saying why.
 */
function LinkCell({ identity, members }: { identity: Identity; members: MemberOption[] }) {
  const link = useApiMutation<{ user_id: number | null }, unknown>(
    { endpoint: '/admin/identities/{id}/link', path: { id: identity.id }, method: 'POST' },
    // The banner and My Focus read the link through /me/context.
    { invalidate: [queryKeyFor(LIST), queryKeyFor({ endpoint: '/me/context' })] },
  );
  const pushToasts = useUiStore((s) => s.pushToasts);
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Member who is {identity.login}</span>
      <select
        className="rounded-md border border-border bg-surface-1 px-1.5 py-0.5 text-xs"
        value={identity.user_id ?? ''}
        disabled={link.isPending}
        data-testid={`identity-link-${identity.id}`}
        onChange={(e) => {
          const value = e.target.value === '' ? null : Number(e.target.value);
          link.mutate(
            { user_id: value },
            {
              onError: (err: Error) =>
                pushToasts([errorToast(`identity-${identity.id}-link-err`, err)]),
            },
          );
        }}
      >
        <option value="">— not linked —</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {m.login}
            {m.auth_provider && m.auth_provider !== 'github' ? ` (${m.auth_provider})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * One row, with its own mutations. Path params live on the descriptor
 * (buildUrl reads them there), so a shared mutation cannot be retargeted per
 * click — the same shape Members.tsx uses for role changes.
 */
function IdentityRow({
  identity,
  targetLogin,
  onMergeClick,
  members,
  host,
}: {
  identity: Identity;
  targetLogin: string | null;
  onMergeClick: () => void;
  members: MemberOption[];
  host?: string | undefined;
}) {
  const setBot = useApiMutation<{ is_bot: boolean }, unknown>(
    { endpoint: '/admin/identities/{id}', path: { id: identity.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const unmerge = useApiMutation<{ into_id: null }, unknown>(
    { endpoint: '/admin/identities/{id}/merge', path: { id: identity.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  // W20-04 (UX_TODO ADM-10): a refused bot flag or undo used to fail in
  // silence — the checkbox just sprang back.
  const pushToasts = useUiStore((s) => s.pushToasts);
  const onError = (err: Error) => pushToasts([errorToast(`identity-${identity.id}-err`, err)]);

  return (
    <tr className="border-t border-border" data-testid={`identity-${identity.id}`}>
      <th scope="row" className="py-1 text-left font-normal">
        {identity.login}
        <span
          className="ml-1.5 rounded-sm bg-surface-2 px-1 text-xs text-fg-muted"
          data-testid={`identity-provider-${identity.id}`}
        >
          {identity.provider}
          {host ? ` · ${host}` : ''}
        </span>
        {/* Paired mark + text, never colour alone (UX_SPEC §7). */}
        {identity.email_fallback && (
          <span
            className="ml-1.5 text-xs text-fg-muted"
            title="No forge account resolved for this author"
          >
            ✉ email-only
          </span>
        )}
      </th>
      <td className="py-1 tabular-nums">{identity.commits}</td>
      <td className="py-1 tabular-nums">{identity.prs}</td>
      <td className="py-1">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={identity.is_bot}
            disabled={setBot.isPending}
            data-testid={`identity-bot-${identity.id}`}
            onChange={(e) =>
              setBot.mutate(
                { is_bot: e.target.checked },
                {
                  onError,
                  onSuccess: () =>
                    pushToasts([
                      {
                        id: `identity-${identity.id}-bot-ok`,
                        tone: 'ok',
                        message: `${identity.login} ${e.target.checked ? 'flagged as a bot' : 'no longer a bot'}. ${RECOMPUTE_NOTE}`,
                      },
                    ]),
                },
              )
            }
          />
          <span className="sr-only">Flag {identity.login} as a bot</span>
        </label>
      </td>
      <td className="py-1">
        <LinkCell identity={identity} members={members} />
      </td>
      <td className="py-1">
        {identity.merged_into_id === null ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <span>{targetLogin ?? `#${identity.merged_into_id}`}</span>
        )}
      </td>
      <td className="py-1">
        {identity.merged_into_id === null ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`identity-merge-${identity.id}`}
            onClick={onMergeClick}
          >
            Merge…
          </button>
        ) : (
          // Reversible by design (DATABASE.md §2): the row was never destroyed,
          // so undo is a real operation rather than a promise.
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`identity-unmerge-${identity.id}`}
            disabled={unmerge.isPending}
            onClick={() => unmerge.mutate({ into_id: null }, { onError })}
          >
            Undo merge
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * The merge action for one chosen source identity.
 *
 * Pick, then CONFIRM (W20-04, UX_TODO ADM-10). A merge rewrites authorship on
 * every screen, and it applied on a single click while the picker closed
 * before the request had even been answered — so a refused merge vanished
 * without a word and a mis-click was already live. The picker now stays open
 * until the API says yes, and says why when it says no.
 */
interface CandidateGroups {
  groups: { display_name: string; members: { id: number; login: string }[] }[];
}

/** Suggested targets first: identities the API grouped with this one by name (ADM-36). */
export function suggestedTargetIds(sourceId: number, data: CandidateGroups | undefined): number[] {
  const out: number[] = [];
  for (const g of data?.groups ?? []) {
    if (!g.members.some((m) => m.id === sourceId)) continue;
    for (const m of g.members) if (m.id !== sourceId && !out.includes(m.id)) out.push(m.id);
  }
  return out;
}

function MergePicker({
  source,
  hosts,
  onDone,
}: {
  source: Identity;
  hosts: ReadonlyMap<string, string>;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<Identity | null>(null);
  // Thousands of identities at 500 repositories: find the target by typing,
  // searched on the server (W20-22, X-17).
  const [find, setFind] = useState('');
  const deferredFind = useDeferredValue(find);
  const { data: found } = useApiQuery<IdentityPage>({
    endpoint: '/admin/identities',
    query: {
      ...(deferredFind.trim() ? { q: deferredFind.trim() } : {}),
      merged: 'false',
      limit: '50',
    },
  });
  // W20-22 (UX_TODO ADM-36): the API's suggestions (same display name) were
  // never shown; they now lead the list.
  const { data: candidates } = useApiQuery<CandidateGroups>({
    endpoint: '/admin/identities/candidates',
  });
  const suggested = suggestedTargetIds(source.id, candidates);
  const pool = (found?.items ?? []).filter((t) => t.id !== source.id);
  const shown = [
    ...pool.filter((t) => suggested.includes(t.id)),
    ...pool.filter((t) => !suggested.includes(t.id)),
  ];
  const merge = useApiMutation<{ into_id: number }, unknown>(
    { endpoint: '/admin/identities/{id}/merge', path: { id: source.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const pushToasts = useUiStore((s) => s.pushToasts);
  // W20-22 (ADM-36): the picker opened below the whole table with no scroll or
  // focus move; it now takes focus where it appears.
  const panel = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest' });
    findInput.current?.focus();
  }, [source.id]);

  return (
    <WidgetFrame title={`Merge ${identityLabel(source, hosts)} into…`} state="ready">
      <div className="flex flex-col gap-2" data-testid="merge-picker" ref={panel}>
        <p className="text-xs text-fg-muted">
          The merged identity keeps its commits — they are re-attributed to the survivor, and the
          merge can be undone. {RECOMPUTE_NOTE}
        </p>
        {target === null ? (
          <div className="flex flex-col gap-1.5">
            <input
              ref={findInput}
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find an identity"
              aria-label="Find the identity to merge into"
              className="w-64 rounded-md border border-border bg-surface px-2 py-1 text-xs"
              data-testid="merge-find"
            />
            <div className="flex flex-wrap gap-1.5">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`merge-into-${t.id}`}
                  onClick={() => setTarget(t)}
                >
                  {identityLabel(t, hosts)}
                  {suggested.includes(t.id) && (
                    <span className="ml-1 text-fg-muted" data-testid={`merge-suggested-${t.id}`}>
                      · suggested, same name
                    </span>
                  )}
                </button>
              ))}
            </div>
            {(found?.total ?? 0) > shown.length && (
              <p className="text-xs text-fg-muted">
                Showing {shown.length} of {found?.total}; type to narrow.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="merge-confirm">
            <p className="text-sm">
              Merge <span className="font-medium">{identityLabel(source, hosts)}</span> into{' '}
              <span className="font-medium">{identityLabel(target, hosts)}</span>? Its{' '}
              {source.commits} commits and {source.prs} pull requests are re-attributed on every
              screen.
            </p>
            <div className="flex gap-1.5">
              <button
                type="button"
                className="rounded-md border border-accent px-2 py-1 text-xs hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="merge-confirm-do"
                disabled={merge.isPending}
                onClick={() =>
                  merge.mutate(
                    { into_id: target.id },
                    {
                      onSuccess: () => {
                        pushToasts([
                          {
                            id: `identity-${source.id}-merge-ok`,
                            tone: 'ok',
                            message: `${source.login} merged into ${target.login}. ${RECOMPUTE_NOTE}`,
                          },
                        ]);
                        onDone();
                      },
                    },
                  )
                }
              >
                {merge.isPending ? 'Merging…' : `Merge into ${identityLabel(target, hosts)}`}
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                data-testid="merge-confirm-back"
                disabled={merge.isPending}
                onClick={() => {
                  merge.reset();
                  setTarget(null);
                }}
              >
                Choose another
              </button>
            </div>
            <ErrorNote error={merge.error} testId="merge-error" />
          </div>
        )}
        <div>
          <button
            type="button"
            className="text-xs text-fg-muted underline underline-offset-2"
            onClick={onDone}
          >
            Cancel
          </button>
        </div>
      </div>
    </WidgetFrame>
  );
}

export function Identities() {
  const [filter, setFilter] = useState<IdentityFilter>({ query: '', provider: '', bots: 'all' });
  const [page, setPage] = useState(0);
  // Searched on the server (W20-22, X-17); the deferred value keeps typing
  // responsive while the previous page stays on screen.
  const deferredFilter = useDeferredValue(filter);
  const { data, isLoading, isError, error, refetch } = useApiQuery<IdentityPage>({
    ...LIST,
    query: identityQuery(deferredFilter, page),
  });
  const [mergeSource, setMergeSource] = useState<Identity | null>(null);
  const { data: memberData } = useApiQuery<{ items: MemberOption[] }>(MEMBERS);
  const members = (memberData?.items ?? []).filter((m) => typeof m.user_id === 'number');
  const { data: connections } = useApiQuery<ConnectionList>({ endpoint: '/connections' });
  const hosts = hostsByProvider(connections?.items ?? []);

  const pageItems = data?.items ?? [];
  const matchingCount = data?.total ?? pageItems.length;
  const allCount = data?.all ?? matchingCount;
  const providers = data?.providers ?? [...new Set(pageItems.map((i) => i.provider))].sort();
  const pages = Math.max(1, Math.ceil(matchingCount / IDENTITY_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const update = (patch: Partial<IdentityFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(0);
  };
  const unfiltered = filter.query.trim() === '' && filter.provider === '' && filter.bots === 'all';

  return (
    <div className="flex flex-col gap-4" data-testid="identities">
      <WidgetFrame
        title="Identities"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && pageItems.length === 0 && unfiltered,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No identities yet — they appear as commits and pull requests are ingested."
      >
        {/* W20-15 (UX_TODO X-17): search, forge and bot filters, and pages —
            one unsearchable table of thousands of identities was unusable. */}
        <div
          className="mb-2 flex flex-wrap items-center gap-2 text-xs"
          data-testid="identity-filters"
        >
          <input
            type="search"
            value={filter.query}
            onChange={(e) => update({ query: e.target.value })}
            placeholder="Search login or name"
            aria-label="Search identities"
            className="w-56 rounded-md border border-border bg-surface px-2 py-1"
            data-testid="identity-search"
          />
          <select
            value={filter.provider}
            onChange={(e) => update({ provider: e.target.value })}
            aria-label="Forge"
            className="rounded-md border border-border bg-surface px-2 py-1"
            data-testid="identity-provider-filter"
          >
            <option value="">Every forge</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
                {hosts.get(p) ? ` · ${hosts.get(p)}` : ''}
              </option>
            ))}
          </select>
          <select
            value={filter.bots}
            onChange={(e) => update({ bots: e.target.value as IdentityFilter['bots'] })}
            aria-label="Bots"
            className="rounded-md border border-border bg-surface px-2 py-1"
            data-testid="identity-bot-filter"
          >
            <option value="all">People and bots</option>
            <option value="humans">People only</option>
            <option value="bots">Bots only</option>
          </select>
          <span className="text-fg-muted" data-testid="identity-count">
            {matchingCount} of {allCount}
          </span>
        </div>
        {/* W18-28: scrolls in its own region at phone width; padded cells
            no longer fit 390px, and the page must not scroll sideways. */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Workspace identities"
        >
          <table className="table-plain w-full text-sm">
            <caption className="sr-only">
              Workspace identities, their weight, the member each one is, and merge state
            </caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Identity</th>
                <th scope="col">Commits</th>
                <th scope="col">PRs</th>
                <th scope="col">Bot</th>
                <th scope="col">Member</th>
                <th scope="col">Merged into</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody data-testid="identity-rows">
              {pageItems.map((i) => (
                <IdentityRow
                  key={i.id}
                  identity={i}
                  targetLogin={i.merged_into_login ?? null}
                  onMergeClick={() => setMergeSource(i)}
                  members={members}
                  host={hosts.get(i.provider)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="mt-2 flex items-center gap-2 text-xs" data-testid="identity-pager">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              className="rounded-md border border-border px-2 py-0.5 disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-fg-muted">
              Page {current + 1} of {pages}
            </span>
            <button
              type="button"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              className="rounded-md border border-border px-2 py-0.5 disabled:opacity-50"
              data-testid="identity-next"
            >
              Next
            </button>
          </div>
        )}
      </WidgetFrame>

      {mergeSource !== null && (
        <MergePicker source={mergeSource} hosts={hosts} onDone={() => setMergeSource(null)} />
      )}
    </div>
  );
}
