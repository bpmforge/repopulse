import { useState } from 'react';
import {
  DataTable,
  SeverityBadge,
  WidgetFrame,
  frameState,
  useUiStore,
  type DataTableColumn,
} from '../../components/index.js';
import { docsUrl } from '../../lib/docs.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { errorDetailOf, requestIdOf } from '../../api/client.js';
import type { ConnectionList, ConnectionSummary } from './contracts.js';
import { RepoPicker } from './RepoPicker.js';

// Admin → Connections (UX_SPEC §4.i). This is the screen docs/INSTALL.md sends
// operators to, and the only way to connect an organisation.

const LIST = { endpoint: '/connections' } as const;

/** What each forge's token needs, in the words its settings page uses. */
const SCOPES: Record<'github' | 'gitlab' | 'gitea', string> = {
  github: 'repo and read:org (or a fine-grained token with read access to the repositories)',
  gitlab: 'read_api',
  gitea: 'read:repository, read:organization and read:user',
};

/**
 * A plain sentence for each validation failure (W20-04, UX_TODO INS-05).
 *
 * The API answers `Credential validation failed: bad_token` — accurate, and a
 * code rather than a next step. INSTALL.md promises the reason by name, so the
 * kind maps to what to do about it, and the API's own detail rides underneath.
 */
export function connectErrorSentence(
  title: string,
  provider: 'github' | 'gitlab' | 'gitea',
): string | null {
  const kind = /Credential validation failed: (\w+)/.exec(title)?.[1];
  switch (kind) {
    case 'bad_token':
      return 'The forge rejected this token. It may be mistyped, expired or revoked — create a new one and paste it again.';
    case 'bad_scope':
      return `The token works but cannot read enough. Give it these scopes: ${SCOPES[provider]}.`;
    case 'no_repos':
      return 'The token works but can see no repositories. Check that its owner is a member of the organisation, or that a fine-grained token includes the repositories.';
    default:
      return null;
  }
}

function ConnectError({
  error,
  provider,
}: {
  error: Error;
  provider: 'github' | 'gitlab' | 'gitea';
}) {
  const sentence = connectErrorSentence(error.message, provider);
  const detail = errorDetailOf(error);
  const requestId = requestIdOf(error);
  return (
    <span className="flex flex-col text-xs text-crit" role="alert" data-testid="connection-error">
      <span>{sentence ?? error.message}</span>
      {detail ? (
        <span className="text-fg-muted" data-testid="connection-error-detail">
          {detail}
        </span>
      ) : null}
      {requestId ? <span className="font-mono text-fg-faint">(request {requestId})</span> : null}
    </span>
  );
}

type Row = ConnectionSummary;

export function Connections() {
  const [credential, setCredential] = useState('');
  // D1a: the customer points RepoPulse at THEIR forge, which may not be GitHub.
  // The provider was hardcoded here, so GitLab and Gitea were unreachable from
  // the UI no matter what the API accepted.
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'gitea'>('github');
  // W14-02: per connection, not per deployment. A self-hosted Gitea and
  // github.com can now be two connections in one workspace; the server-level
  // FORGE_BASE_URL is the default, not the only answer.
  const [baseUrl, setBaseUrl] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const pushToasts = useUiStore((s) => s.pushToasts);

  const { data, isLoading, isError, error, refetch } = useApiQuery<ConnectionList>(LIST);

  const create = useApiMutation<
    { provider: string; auth_kind: string; credential: string; base_url?: string },
    { id: number; status: string; fingerprint: string }
  >({ endpoint: '/connections' }, { invalidate: [queryKeyFor(LIST)] });

  const items = data?.items ?? [];

  const columns: DataTableColumn<Row>[] = [
    { id: 'provider', header: 'Provider', cell: (row) => row.provider },
    {
      id: 'host',
      header: 'Instance',
      // The HOST, not the whole URL: the column exists so two connections to
      // two forges are told apart at a glance, and a full URL crowds that out.
      cell: (row) => (
        <span className="text-fg-muted">
          {row.base_url ? new URL(row.base_url).host : 'server default'}
        </span>
      ),
    },
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
        <SeverityBadge severity={row.status === 'active' ? 'low' : 'medium'} label={row.status} />
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
      <WidgetFrame
        title="Connect an organisation"
        state="ready"
        definitionHref={docsUrl('/docs/INSTALL.md')}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!credential.trim()) return;
            create.mutate(
              {
                provider,
                auth_kind: 'pat',
                credential: credential.trim(),
                ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
              },
              {
                onSuccess: (res) => {
                  // Clear immediately: a token left in a form field survives in
                  // the DOM and in any screenshot the operator takes next.
                  setCredential('');
                  setSubmitted(`Connected (${res.status})`);
                  pushToasts([{ id: `conn-${res.id}`, tone: 'ok', message: 'Connection created' }]);
                },
              },
            );
          }}
        >
          <label className="text-xs text-fg-muted" htmlFor="connection-provider">
            Forge
          </label>
          <select
            id="connection-provider"
            data-testid="connection-provider"
            className="panel px-2 py-1 text-sm"
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab' | 'gitea')}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="gitea">Gitea</option>
          </select>
          <label className="text-xs text-fg-muted" htmlFor="connection-base-url">
            {provider === 'gitea'
              ? 'Instance URL (required — Gitea is self-hosted)'
              : 'Instance URL (optional — blank uses the server default)'}
          </label>
          <input
            id="connection-base-url"
            type="url"
            autoComplete="off"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            // Deliberately NOT the real GitHub API host: validate-arch rule 4
            // forbids that literal outside packages/forge, and a placeholder is
            // not worth an exemption to the rule that keeps forge hosts in one
            // place.
            placeholder={
              provider === 'gitea' ? 'https://git.example.com' : 'leave blank for GitHub'
            }
            className="panel px-2 py-1 text-sm"
            data-testid="connection-base-url"
          />
          <label className="text-xs text-fg-muted" htmlFor="connection-credential">
            {/* W16-25: GitHub was the ONE forge that named no scope, while
                being the primary README-first forge. A wrong scope does not
                fail here — it fails later, during ingestion, far from this
                form. */}
            {provider === 'github'
              ? 'GitHub personal access token (repo, read:org)'
              : provider === 'gitlab'
                ? 'GitLab personal access token (read_api)'
                : 'Gitea access token (read:repository)'}
          </label>
          <input
            id="connection-credential"
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="ghp_… — a classic PAT, or a fine-grained token with read access"
            className="panel px-2 py-1 text-sm"
            data-testid="connection-credential"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={create.isPending || credential.trim() === ''}
              className="panel-inset px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="connection-submit"
            >
              {create.isPending ? 'Connecting…' : 'Connect'}
            </button>
            {create.isError && <ConnectError error={create.error} provider={provider} />}
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
        {...(error ? { errorMessage: error.message, error } : {})}
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
