import { useState } from 'react';
import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import type { ConnectionList, ConnectionSummary } from './contracts.js';
import { RepoPicker } from './RepoPicker.js';

// Admin → Connections (UX_SPEC §4.i). This is the screen docs/INSTALL.md sends
// operators to, and the only way to connect an organisation.

const LIST = { endpoint: '/connections' } as const;

type Row = ConnectionSummary;

export function Connections() {
  const [credential, setCredential] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const pushToasts = useUiStore((s) => s.pushToasts);

  const { data, isLoading, isError, error, refetch } = useApiQuery<ConnectionList>(LIST);

  const create = useApiMutation<
    { provider: string; auth_kind: string; credential: string },
    { id: number; status: string; fingerprint: string }
  >({ endpoint: '/connections' }, { invalidate: [queryKeyFor(LIST)] });

  const items = data?.items ?? [];

  const columns: DataTableColumn<Row>[] = [
    { id: 'provider', header: 'Provider', cell: (row) => row.provider },
    { id: 'kind', header: 'Auth', cell: (row) => row.auth_kind },
    {
      id: 'cred',
      header: 'Credential',
      // Never the credential — the API returns a fingerprint and its last 4 for
      // exactly this display (SC-2). Showing more would put a token in the DOM.
      cell: (row) => <span className="tabular-nums">…{row.last4}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          <SeverityBadge severity={row.status === 'active' ? 'low' : 'medium'} />
          <span>{row.status}</span>
        </span>
      ),
    },
    {
      id: 'repos',
      header: 'Repos',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.repo_count}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="admin-connections">
      <WidgetFrame title="Connect an organisation" state="ready" definitionHref="/docs/INSTALL.md">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!credential.trim()) return;
            create.mutate(
              { provider: 'github', auth_kind: 'pat', credential: credential.trim() },
              {
                onSuccess: (res) => {
                  // Clear immediately: a token left in a form field survives in
                  // the DOM and in any screenshot the operator takes next.
                  setCredential('');
                  setSubmitted(`Connected (${res.status})`);
                  pushToasts([
                    { id: `conn-${res.id}`, tone: 'ok', message: 'Connection created' },
                  ]);
                },
              },
            );
          }}
        >
          <label className="text-xs text-fg-muted" htmlFor="connection-credential">
            GitHub token or installation credential
          </label>
          <input
            id="connection-credential"
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="ghp_… or an app installation id"
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            data-testid="connection-credential"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={create.isPending || credential.trim() === ''}
              className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="connection-submit"
            >
              {create.isPending ? 'Connecting…' : 'Connect'}
            </button>
            {create.isError && (
              <span className="text-xs text-crit" role="alert" data-testid="connection-error">
                {create.error.message}
              </span>
            )}
            {submitted && !create.isError && (
              <span className="text-xs text-fg-muted" data-testid="connection-result">
                {submitted}
              </span>
            )}
          </div>
        </form>
      </WidgetFrame>

      {items.map((c) => (
        <RepoPicker key={c.id} connectionId={c.id} connectionsKey={queryKeyFor(LIST)} />
      ))}

      <WidgetFrame
        title="Connections"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No connections yet. Add a credential above to connect your organisation."
      >
        <div data-testid="connection-list">
          <DataTable
            name="admin-connections"
            columns={columns}
            data={items}
            getRowId={(row) => String(row.id)}
          />
        </div>
      </WidgetFrame>
    </div>
  );
}
