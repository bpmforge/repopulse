import { useEffect, useRef, useState } from 'react';
import {
  DataTable,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import { errorToast, type Toast } from '../../components/store/uiStore.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { MeContext } from '../org/contracts.js';

// Settings → Members (W4-20, FR-AUTH-4). Replaces the empty state that pointed at
// this ticket: roles were always enforced, they just could not be managed from
// anywhere.

const LIST = { endpoint: '/admin/members' } as const;

export interface MemberRow {
  user_id: number;
  login: string;
  role: 'admin' | 'member';
  /** `local`, `github` or `oidc` (W20-07). Optional: an older API omits it. */
  auth_provider?: string;
  joined_at: string;
}

/**
 * Reset password (W20-07, UX_TODO INS-03).
 *
 * There was no way back from a forgotten password: no "forgot password", no
 * admin action, no CLI. This issues a one-time temporary password that is
 * shown HERE, once, for the admin to hand over; the account must replace it at
 * its next sign-in. Only for local accounts — GitHub and SSO users reset with
 * their provider, so the button would be a door to nowhere for them.
 */
function ResetPasswordButton({ row, onToast }: { row: MemberRow; onToast: (t: Toast[]) => void }) {
  const [confirming, setConfirming] = useState(false);
  const reset = useApiMutation<undefined, { temporary_password: string }>({
    endpoint: '/admin/members/{userId}/reset-password',
    path: { userId: row.user_id },
    method: 'POST',
  });

  if (row.auth_provider !== 'local') {
    return (
      <span className="text-xs text-fg-faint">
        {row.auth_provider
          ? `signs in with ${row.auth_provider === 'oidc' ? 'SSO' : 'GitHub'}`
          : ''}
      </span>
    );
  }

  if (reset.isSuccess) {
    return (
      <div className="flex flex-col gap-1" data-testid={`member-reset-result-${row.user_id}`}>
        <p className="max-w-md text-xs text-fg-muted">
          Temporary password for <span className="text-fg">{row.login}</span> — shown once. Give it
          to them privately; they must choose a new one when they sign in.
        </p>
        <code
          className="select-all rounded-sm bg-surface-2 px-2 py-1 font-mono text-xs"
          data-testid={`member-reset-password-${row.user_id}`}
        >
          {reset.data.temporary_password}
        </code>
        <div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
            onClick={() => {
              // Dropped from memory and the DOM once the admin is done with it.
              reset.reset();
              setConfirming(false);
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        data-testid={`member-reset-${row.user_id}`}
        onClick={() => setConfirming(true)}
      >
        Reset password…
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid={`member-reset-confirm-${row.user_id}`}>
      <p className="max-w-md text-xs text-fg-muted">
        Reset <span className="text-fg">{row.login}</span>’s password? Their current password stops
        working now, and you will get a one-time temporary password to give them.
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          className="rounded-md border border-accent px-2 py-1 text-xs hover:bg-accent/10"
          data-testid={`member-reset-do-${row.user_id}`}
          disabled={reset.isPending}
          onClick={() =>
            reset.mutate(undefined, {
              onError: (err: Error) =>
                onToast([errorToast(`member-reset-${row.user_id}-err`, err)]),
            })
          }
        >
          Reset password
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One button per row, each with its OWN mutation — the descriptor (and so the
 * URL) is fixed when the hook is created, so a single shared mutation cannot
 * carry a per-row user id. Same shape as RepoPicker, which is per-connection
 * for the same reason.
 */
function RoleButton({
  row,
  isSelf,
  onToast,
}: {
  row: MemberRow;
  /** True when this row is the signed-in admin (W20-04, UX_TODO ADM-11). */
  isSelf: boolean;
  onToast: (t: Toast[]) => void;
}) {
  const next = row.role === 'admin' ? 'member' : 'admin';
  // Two-step, like Remove (W20-04, UX_TODO ADM-11). A role change applied on
  // one click, and an admin who demoted themselves lost Settings on the spot,
  // with the page they were on turning into an "ask an admin" wall.
  const [confirming, setConfirming] = useState(false);
  const setRole = useApiMutation<{ role: string }, { user_id: number; role: string }>(
    { endpoint: '/admin/members/{userId}', path: { userId: row.user_id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  if (!confirming) {
    return (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        data-testid={`member-role-${row.user_id}`}
        onClick={() => setConfirming(true)}
      >
        Make {next}…
      </button>
    );
  }

  const consequence =
    next === 'admin'
      ? 'They will be able to change connections, members, models and analysis policy.'
      : isSelf
        ? 'You will lose access to Settings as soon as this applies, and only another admin can give it back.'
        : 'They will lose access to Settings.';

  return (
    <div className="flex flex-col gap-1" data-testid={`member-role-confirm-${row.user_id}`}>
      <p
        className={`max-w-md text-xs ${isSelf && next === 'member' ? 'text-warn' : 'text-fg-muted'}`}
        data-testid={`member-role-consequence-${row.user_id}`}
      >
        Make <span className="text-fg">{isSelf ? 'yourself' : row.login}</span>{' '}
        {next === 'admin' ? 'an admin' : 'a member'}? {consequence}
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          className="rounded-md border border-accent px-2 py-1 text-xs hover:bg-accent/10"
          data-testid={`member-role-do-${row.user_id}`}
          disabled={setRole.isPending}
          onClick={() =>
            setRole.mutate(
              { role: next },
              {
                // The API refuses to demote the LAST admin (409) because that
                // would lock the workspace out of every admin surface. Surface
                // THAT reason, with its detail, rather than a generic failure.
                onError: (err: Error) => onToast([errorToast(`member-${row.user_id}-err`, err)]),
                onSuccess: () => {
                  setConfirming(false);
                  onToast([
                    {
                      id: `member-${row.user_id}-ok`,
                      tone: 'ok',
                      message: `${row.login} is now ${next}`,
                    },
                  ]);
                },
              },
            )
          }
        >
          Make {next}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
          data-testid={`member-role-cancel-${row.user_id}`}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What removing a member leaves behind (W20-19, UX_TODO ADM-48/49). */
export interface MemberHoldings {
  ci_tokens: number;
  shared_views: number;
  private_views: number;
  connections: number;
}

/**
 * The Remove confirmation's consequence sentence (W20-19, UX_TODO ADM-48/49;
 * decision 2026-10-20): CI tokens are revoked; connections and shared views
 * stay with the workspace (the shared views move to you); private views go.
 * Without counts (still loading, or an older API) it says the rule anyway.
 */
export function removeConsequenceText(h: MemberHoldings | undefined): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!h || typeof h.ci_tokens !== 'number') {
    return 'Their CI tokens are revoked. Forge connections and shared views stay with the workspace (shared views move to you); their private saved views go with the account. Reports, plans, agreements and triage history stay, still showing their name.';
  }
  const parts: string[] = [];
  parts.push(
    h.ci_tokens > 0
      ? `${plural(h.ci_tokens, 'CI token', 'CI tokens')} they created ${h.ci_tokens === 1 ? 'is' : 'are'} revoked, so any pipeline using ${h.ci_tokens === 1 ? 'it' : 'them'} stops reading findings.`
      : 'They have no active CI tokens.',
  );
  if (h.connections > 0) {
    parts.push(
      `${plural(h.connections, 'forge connection', 'forge connections')} they added ${h.connections === 1 ? 'stays' : 'stay'} with the workspace and keep${h.connections === 1 ? 's' : ''} syncing.`,
    );
  }
  if (h.shared_views > 0) {
    parts.push(
      `${plural(h.shared_views, 'shared view', 'shared views')} ${h.shared_views === 1 ? 'stays' : 'stay'} with the workspace and ${h.shared_views === 1 ? 'moves' : 'move'} to you.`,
    );
  }
  if (h.private_views > 0) {
    parts.push(
      `${plural(h.private_views, 'private saved view', 'private saved views')} ${h.private_views === 1 ? 'goes' : 'go'} with the account.`,
    );
  }
  parts.push('Reports, plans, agreements and triage history stay, still showing their name.');
  return parts.join(' ');
}

/**
 * Remove a member (W16-59).
 *
 * Two-step, because it is the most destructive control in the product and the
 * confirm step is where the CONSEQUENCES are stated. Until the FK migration
 * that preceded this, a member who had used RepoPulse could not be removed at
 * all — one report or one triaged finding made the account permanently
 * undeletable — so nobody has ever seen this happen and nobody has intuitions
 * about what it takes with it.
 *
 * What it takes and what it leaves is the whole message: their saved views go,
 * because ownership there gates who can see and edit one; their reports, plans,
 * agreements and triage history stay, with their login preserved beside each,
 * because the work was done and removing a login does not un-do it.
 */
function RemoveButton({
  row,
  blockedReason,
  onToast,
}: {
  row: MemberRow;
  /**
   * Why this row cannot be removed, when the API would refuse it (W20-17,
   * UX_TODO ADM-35): yourself, or the last admin. It used to refuse only after
   * the consequences had been read and confirmed.
   */
  blockedReason?: string | null;
  onToast: (t: Toast[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Counted only once someone asks to remove (W20-19, ADM-48/49).
  const { data: holdings } = useApiQuery<MemberHoldings>(
    { endpoint: '/admin/members/{userId}/holdings', path: { userId: row.user_id } },
    { enabled: confirming },
  );
  const remove = useApiMutation<
    undefined,
    {
      user_id: number;
      removed: boolean;
      ci_tokens_revoked?: number;
      shared_views_transferred?: number;
    }
  >(
    { endpoint: '/admin/members/{userId}', path: { userId: row.user_id }, method: 'DELETE' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  // W20-17 (UX_TODO ADM-69): focus follows the swap both ways, so a keyboard
  // or screen-reader user hears the consequences and lands back on the button.
  const textRef = useRef<HTMLParagraphElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) textRef.current?.focus();
    else if (wasConfirming.current) buttonRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (blockedReason) {
    return (
      <span className="flex flex-col gap-0.5">
        <button
          type="button"
          className="w-fit rounded-md border border-border px-2 py-1 text-xs opacity-50"
          data-testid={`member-remove-${row.user_id}`}
          disabled
          aria-describedby={`member-remove-why-${row.user_id}`}
        >
          Remove…
        </button>
        <span
          id={`member-remove-why-${row.user_id}`}
          className="text-xs text-fg-faint"
          data-testid={`member-remove-why-${row.user_id}`}
        >
          {blockedReason}
        </span>
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        ref={buttonRef}
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-crit"
        data-testid={`member-remove-${row.user_id}`}
        onClick={() => setConfirming(true)}
      >
        Remove…
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid={`member-remove-confirm-${row.user_id}`}>
      <p
        ref={textRef}
        tabIndex={-1}
        className="max-w-md text-xs text-fg-muted outline-none"
        data-testid={`member-remove-consequence-${row.user_id}`}
      >
        Remove <span className="text-fg">{row.login}</span>? {removeConsequenceText(holdings)}
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10"
          data-testid={`member-remove-do-${row.user_id}`}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              // The API refuses the LAST admin and refuses self-removal, both
              // with 409 and both with a reason someone can act on. Surface the
              // reason rather than a generic failure.
              onError: (err: Error) => onToast([errorToast(`member-rm-${row.user_id}-err`, err)]),
              onSuccess: (res) => {
                setConfirming(false);
                const revoked = res.ci_tokens_revoked ?? 0;
                const moved = res.shared_views_transferred ?? 0;
                onToast([
                  {
                    id: `member-rm-${row.user_id}-ok`,
                    tone: 'ok',
                    message:
                      `${row.login} was removed from this workspace` +
                      (revoked > 0
                        ? `; ${revoked} CI token${revoked === 1 ? '' : 's'} revoked`
                        : '') +
                      (moved > 0
                        ? `; ${moved} shared view${moved === 1 ? '' : 's'} moved to you`
                        : ''),
                  },
                ]);
              },
            })
          }
        >
          Remove {row.login}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
          data-testid={`member-remove-cancel-${row.user_id}`}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Members() {
  const pushToasts = useUiStore((s) => s.pushToasts);
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: MemberRow[] }>(LIST);
  // Which row is "you" (W20-04, UX_TODO ADM-11): the shell already holds this.
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  const items = data?.items ?? [];
  const adminCount = items.filter((m) => m.role === 'admin').length;
  /** What the API would refuse (ADM-35), said before anyone confirms. */
  const removeBlocked = (row: MemberRow): string | null =>
    me?.user_id === row.user_id
      ? 'You cannot remove yourself; another admin can.'
      : row.role === 'admin' && adminCount <= 1
        ? 'The only admin cannot be removed; make someone else admin first.'
        : null;

  const columns: DataTableColumn<MemberRow>[] = [
    {
      id: 'login',
      header: 'Member',
      // W20-17 (UX_TODO ADM-35): which row is you, and when each joined.
      cell: (row) => (
        <span className="flex flex-col">
          <span data-testid={`member-login-${row.user_id}`}>
            {row.login}
            {me?.user_id === row.user_id && <span className="ml-1 text-fg-muted">(you)</span>}
          </span>
          {row.joined_at && (
            <span className="text-xs text-fg-faint">
              joined {new Date(row.joined_at).toLocaleDateString()}
            </span>
          )}
        </span>
      ),
    },
    { id: 'role', header: 'Role', cell: (row) => row.role },
    {
      id: 'action',
      header: 'Change role',
      cell: (row) => (
        <RoleButton row={row} isSelf={me?.user_id === row.user_id} onToast={pushToasts} />
      ),
    },
    {
      id: 'password',
      header: 'Password',
      cell: (row) => <ResetPasswordButton row={row} onToast={pushToasts} />,
    },
    {
      id: 'remove',
      header: 'Remove',
      cell: (row) => (
        <RemoveButton row={row} blockedReason={removeBlocked(row)} onToast={pushToasts} />
      ),
    },
  ];

  return (
    <WidgetFrame
      title="Members"
      state={frameState({ isLoading, isError, isEmpty: items.length === 0 })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      emptyMessage="No members yet."
    >
      {/* W20-19 (UX_TODO INS-61; decision 2026-10-20): accounts are never
          joined by email, so say what a second sign-in route does. */}
      <p className="mb-2 max-w-3xl text-xs text-fg-muted" data-testid="members-one-account-note">
        Each sign-in method makes its own account: someone who signs in with a password and later
        with SSO or GitHub appears here twice, because RepoPulse never joins accounts by email.
        Remove the one they do not use, and link the other to their forge identity in the Identities
        tab.
      </p>
      <div data-testid="members-table">
        <DataTable
          name="admin-members"
          columns={columns}
          data={items}
          getRowId={(row) => String(row.user_id)}
        />
      </div>
    </WidgetFrame>
  );
}
