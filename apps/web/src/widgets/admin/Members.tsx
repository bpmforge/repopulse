import { useState } from 'react';
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

// Admin → Members (W4-20, FR-AUTH-4). Replaces the empty state that pointed at
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
function RemoveButton({ row, onToast }: { row: MemberRow; onToast: (t: Toast[]) => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useApiMutation<undefined, { user_id: number; removed: boolean }>(
    { endpoint: '/admin/members/{userId}', path: { userId: row.user_id }, method: 'DELETE' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  if (!confirming) {
    return (
      <button
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
      <p className="max-w-md text-xs text-fg-muted">
        Remove <span className="text-fg">{row.login}</span>? Their saved views go with the account.
        Reports, plans, agreements and triage history stay, still showing their name.
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
              onSuccess: () => {
                setConfirming(false);
                onToast([
                  {
                    id: `member-rm-${row.user_id}-ok`,
                    tone: 'ok',
                    message: `${row.login} was removed from this workspace`,
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

  const columns: DataTableColumn<MemberRow>[] = [
    { id: 'login', header: 'Member', cell: (row) => row.login },
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
      cell: (row) => <RemoveButton row={row} onToast={pushToasts} />,
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
