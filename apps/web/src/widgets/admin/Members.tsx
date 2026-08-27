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
