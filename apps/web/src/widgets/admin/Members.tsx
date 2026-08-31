import { useState } from 'react';
import {
  DataTable,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import type { Toast } from '../../components/store/uiStore.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Members (W4-20, FR-AUTH-4). Replaces the empty state that pointed at
// this ticket: roles were always enforced, they just could not be managed from
// anywhere.

const LIST = { endpoint: '/admin/members' } as const;

export interface MemberRow {
  user_id: number;
  login: string;
  role: 'admin' | 'member';
  joined_at: string;
}

/**
 * One button per row, each with its OWN mutation — the descriptor (and so the
 * URL) is fixed when the hook is created, so a single shared mutation cannot
 * carry a per-row user id. Same shape as RepoPicker, which is per-connection
 * for the same reason.
 */
function RoleButton({
  row,
  onToast,
}: {
  row: MemberRow;
  onToast: (t: Toast[]) => void;
}) {
  const next = row.role === 'admin' ? 'member' : 'admin';
  const setRole = useApiMutation<{ role: string }, { user_id: number; role: string }>(
    { endpoint: '/admin/members/{userId}', path: { userId: row.user_id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  return (
    <button
      type="button"
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
      data-testid={`member-role-${row.user_id}`}
      disabled={setRole.isPending}
      onClick={() =>
        setRole.mutate(
          { role: next },
          {
            // The API refuses to demote the LAST admin (409) because that would
            // lock the workspace out of every admin surface. Surface THAT reason
            // rather than a generic failure — it is something the operator can
            // act on.
            onError: (err: Error) =>
              onToast([{ id: `member-${row.user_id}-err`, tone: 'crit', message: err.message }]),
            onSuccess: () =>
              onToast([
                { id: `member-${row.user_id}-ok`, tone: 'ok', message: `${row.login} is now ${next}` },
              ]),
          },
        )
      }
    >
      Make {next}
    </button>
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
              onError: (err: Error) =>
                onToast([
                  { id: `member-rm-${row.user_id}-err`, tone: 'crit', message: err.message },
                ]),
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

  const items = data?.items ?? [];

  const columns: DataTableColumn<MemberRow>[] = [
    { id: 'login', header: 'Member', cell: (row) => row.login },
    { id: 'role', header: 'Role', cell: (row) => row.role },
    {
      id: 'action',
      header: 'Change role',
      cell: (row) => <RoleButton row={row} onToast={pushToasts} />,
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
      emptyMessage="No members yet — the first person to sign in becomes this workspace's admin."
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
