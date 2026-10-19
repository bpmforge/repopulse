import { useState } from 'react';
import {
  ErrorNote,
  WidgetFrame,
  errorToast,
  frameState,
  useUiStore,
} from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

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
}

interface MemberOption {
  user_id: number;
  login: string;
  auth_provider?: string;
}

const MEMBERS = { endpoint: '/admin/members' } as const;

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
}: {
  identity: Identity;
  targetLogin: string | null;
  onMergeClick: () => void;
  members: MemberOption[];
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
            onChange={(e) => setBot.mutate({ is_bot: e.target.checked }, { onError })}
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
function MergePicker({
  source,
  targets,
  onDone,
}: {
  source: Identity;
  targets: Identity[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState<Identity | null>(null);
  const merge = useApiMutation<{ into_id: number }, unknown>(
    { endpoint: '/admin/identities/{id}/merge', path: { id: source.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  return (
    <WidgetFrame title={`Merge ${source.login} into…`} state="ready">
      <div className="flex flex-col gap-2" data-testid="merge-picker">
        <p className="text-xs text-fg-muted">
          The merged identity keeps its commits — they are re-attributed to the survivor, and the
          merge can be undone.
        </p>
        {target === null ? (
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`merge-into-${t.id}`}
                onClick={() => setTarget(t)}
              >
                {t.login}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="merge-confirm">
            <p className="text-sm">
              Merge <span className="font-medium">{source.login}</span> into{' '}
              <span className="font-medium">{target.login}</span>? Its {source.commits} commits and{' '}
              {source.prs} pull requests are re-attributed on every screen.
            </p>
            <div className="flex gap-1.5">
              <button
                type="button"
                className="rounded-md border border-accent px-2 py-1 text-xs hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="merge-confirm-do"
                disabled={merge.isPending}
                onClick={() => merge.mutate({ into_id: target.id }, { onSuccess: onDone })}
              >
                {merge.isPending ? 'Merging…' : `Merge into ${target.login}`}
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
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: Identity[] }>(LIST);
  const [mergeSource, setMergeSource] = useState<number | null>(null);
  const { data: memberData } = useApiQuery<{ items: MemberOption[] }>(MEMBERS);
  const members = (memberData?.items ?? []).filter((m) => typeof m.user_id === 'number');

  const items = data?.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const mergeTargets = items.filter((i) => i.merged_into_id === null && i.id !== mergeSource);

  return (
    <div className="flex flex-col gap-4" data-testid="identities">
      <WidgetFrame
        title="Identities"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No identities yet — they appear as commits and pull requests are ingested."
      >
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
              {items.map((i) => (
                <IdentityRow
                  key={i.id}
                  identity={i}
                  targetLogin={
                    i.merged_into_id === null ? null : (byId.get(i.merged_into_id)?.login ?? null)
                  }
                  onMergeClick={() => setMergeSource(i.id)}
                  members={members}
                />
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>

      {mergeSource !== null && byId.get(mergeSource) && (
        <MergePicker
          source={byId.get(mergeSource)!}
          targets={mergeTargets}
          onDone={() => setMergeSource(null)}
        />
      )}
    </div>
  );
}
