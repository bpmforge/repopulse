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
import { errorToast, type Toast } from '../../components/store/uiStore.js';
import type { ConnectionList, ConnectionSummary } from './contracts.js';
import { RepoPicker } from './RepoPicker.js';

// Admin → Connections (UX_SPEC §4.i). This is the screen docs/INSTALL.md sends
// operators to, and the only way to connect an organisation.

const LIST = { endpoint: '/connections' } as const;

/** What each forge's token needs, in the words its settings page uses. */
export const SCOPES: Record<'github' | 'gitlab' | 'gitea', string> = {
  github: 'repo and read:org (or a fine-grained token with read access to the repositories)',
  gitlab: 'read_api',
  gitea: 'read:repository, read:organization and read:user',
};

/**
 * The optional scopes, and what each adds (W20-07, UX_TODO INS-07).
 *
 * The Gitea form said only `read:repository` while INSTALL.md lists three read
 * scopes plus two optional ones, so a token made from the form ingested part of
 * what it should and said nothing: no live updates and no issues, discovered
 * later in Settings → Sync. Same words as INSTALL.md's table and note.
 */
export const OPTIONAL_SCOPES: Record<'github' | 'gitlab' | 'gitea', string | null> = {
  github: null,
  gitlab: null,
  gitea:
    'Optional: write:repository adds live updates (Gitea treats creating the push webhook as a write) and read:issue adds issues. Without them the repositories still backfill.',
};

/** The Instance URL label names the real default per forge (W20-07, UX_TODO INS-73). */
export const BASE_URL_LABEL: Record<'github' | 'gitlab' | 'gitea', string> = {
  github:
    'Instance URL (optional — blank means github.com, or this server’s GitHub Enterprise default)',
  gitlab: 'Instance URL (optional — blank means gitlab.com; give your own for self-managed GitLab)',
  gitea: 'Instance URL (required — Gitea is self-hosted)',
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
    // W20-07 (UX_TODO INS-64): the forge never judged the token in these
    // three, so none of them may tell the admin to replace it.
    case 'wrong_url':
      return 'The forge answered "not found" for the repository listing. The Instance URL is probably wrong — check it, including any path such as /api/v3 for GitHub Enterprise.';
    case 'tls_untrusted':
      return 'RepoPulse does not trust this forge’s certificate — usually an internal CA. Add the CA as described in Installing → “A forge with an internal-CA certificate”; your token was not checked.';
    case 'cannot_reach':
      return 'RepoPulse could not reach the forge, so your token was not checked. The reason is below: check the Instance URL, DNS, any proxy, and that the forge is up.';
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

/**
 * What removing a connection does to its repositories, in words (W20-07,
 * UX_TODO INS-08). Exported for its test: this sentence IS the feature.
 */
export function removeConsequence(repoCount: number): string {
  if (repoCount === 0) {
    return 'It tracks no repositories, so it is deleted outright.';
  }
  return `Its ${repoCount} tracked repositor${repoCount === 1 ? 'y stops' : 'ies stop'} syncing and ${repoCount === 1 ? 'is' : 'are'} paused; history already collected stays on every dashboard. The token and webhook secret are wiped, so the RepoPulse webhooks left on the forge are refused from now on — delete them there if you want them gone. Replace the token later to reconnect.`;
}

/**
 * Replace token / Remove, per connection row (W20-07, UX_TODO INS-08).
 *
 * Before this a connection could only be created: a wrong-but-valid token, a
 * rotated one, or a lost TOKEN_ENC_KEY ("must be re-entered") had no recovery
 * path short of a second connection. Each row owns its mutations because the
 * URL carries the id (same reason as RepoPicker and Members).
 */
function ConnectionActions({ row, onToast }: { row: Row; onToast: (toasts: Toast[]) => void }) {
  const [mode, setMode] = useState<'idle' | 'rekey' | 'remove'>('idle');
  const [token, setToken] = useState('');
  const rekey = useApiMutation<{ credential: string }, { id: number; fingerprint: string }>(
    { endpoint: '/connections/{id}', path: { id: row.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const remove = useApiMutation<undefined, { outcome: string; paused_repos: number }>(
    { endpoint: '/connections/{id}', path: { id: row.id }, method: 'DELETE' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const provider = (
    ['github', 'gitlab', 'gitea'].includes(row.provider) ? row.provider : 'github'
  ) as 'github' | 'gitlab' | 'gitea';
  // W20-10 (UX_TODO ADM-77). Hooks point at the address the install had when
  // each repository was first tracked; after moving it, this points them here.
  const rehook = useApiMutation<
    undefined,
    { url: string; repos: number; registered: number; failed: { repo: string; error: string }[] }
  >({ endpoint: '/connections/{id}/webhooks', path: { id: row.id }, method: 'POST' });
  const reRegister = () =>
    rehook.mutate(undefined, {
      onError: (err: Error) => onToast([errorToast(`conn-hook-${row.id}-err`, err)]),
      onSuccess: (res) =>
        onToast([
          {
            id: `conn-hook-${row.id}`,
            tone: res.failed.length === 0 ? 'ok' : 'warn',
            message:
              res.failed.length === 0
                ? `Webhooks re-registered at ${res.url} for ${res.registered} repositor${res.registered === 1 ? 'y' : 'ies'}`
                : `Webhooks re-registered for ${res.registered} of ${res.repos}; not for ${res.failed
                    .slice(0, 3)
                    .map((f) => `${f.repo} (${f.error})`)
                    .join(
                      ', ',
                    )}${res.failed.length > 3 ? ` and ${res.failed.length - 3} more` : ''}`,
          },
        ]),
    });

  if (mode === 'rekey') {
    return (
      <form
        className="flex flex-col gap-1"
        data-testid={`connection-rekey-form-${row.id}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!token.trim()) return;
          rekey.mutate(
            { credential: token.trim() },
            {
              onSuccess: () => {
                // Cleared at once, like the create form: a token left in a
                // field survives in the DOM and in the next screenshot.
                setToken('');
                setMode('idle');
                onToast([{ id: `conn-rekey-${row.id}`, tone: 'ok', message: 'Token replaced' }]);
              },
            },
          );
        }}
      >
        <label className="text-xs text-fg-muted" htmlFor={`rekey-${row.id}`}>
          New token for this {row.provider} connection — checked against the forge before it
          replaces the old one
        </label>
        <input
          id={`rekey-${row.id}`}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="panel px-2 py-1 text-sm"
          data-testid={`connection-rekey-input-${row.id}`}
        />
        <div className="flex gap-1.5">
          <button
            type="submit"
            disabled={rekey.isPending || token.trim() === ''}
            className="rounded-md border border-accent px-2 py-1 text-xs hover:bg-accent/10 disabled:opacity-50"
            data-testid={`connection-rekey-do-${row.id}`}
          >
            {rekey.isPending ? 'Checking…' : 'Replace token'}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
            onClick={() => {
              setToken('');
              setMode('idle');
            }}
          >
            Cancel
          </button>
        </div>
        {rekey.isError && <ConnectError error={rekey.error} provider={provider} />}
      </form>
    );
  }

  if (mode === 'remove') {
    return (
      <div className="flex flex-col gap-1" data-testid={`connection-remove-confirm-${row.id}`}>
        <p
          className="max-w-md text-xs text-fg-muted"
          data-testid={`connection-remove-consequence-${row.id}`}
        >
          Remove this {row.provider} connection? {removeConsequence(row.repo_count)}
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={remove.isPending}
            className="rounded-md border border-crit px-2 py-1 text-xs text-crit hover:bg-crit/10"
            data-testid={`connection-remove-do-${row.id}`}
            onClick={() =>
              remove.mutate(undefined, {
                onError: (err: Error) => onToast([errorToast(`conn-rm-${row.id}-err`, err)]),
                onSuccess: (res) => {
                  setMode('idle');
                  onToast([
                    {
                      id: `conn-rm-${row.id}`,
                      tone: 'ok',
                      message:
                        res.outcome === 'deleted'
                          ? 'Connection deleted'
                          : `Connection removed — ${res.paused_repos} repo(s) paused, history kept`,
                    },
                  ]);
                },
              })
            }
          >
            Remove connection
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
            onClick={() => setMode('idle')}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        data-testid={`connection-rekey-${row.id}`}
        onClick={() => setMode('rekey')}
      >
        {row.status === 'removed' ? 'Reconnect…' : 'Replace token…'}
      </button>
      {row.status === 'active' && row.repo_count > 0 && (
        <button
          type="button"
          disabled={rehook.isPending}
          title="After changing this install's address (PUBLIC_BASE_URL): point every tracked repository's webhook at the current address. See RUNBOOK → Change the install's address."
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          data-testid={`connection-rehook-${row.id}`}
          onClick={reRegister}
        >
          {rehook.isPending ? 'Re-registering…' : 'Re-register webhooks'}
        </button>
      )}
      {row.status !== 'removed' && (
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-crit"
          data-testid={`connection-remove-${row.id}`}
          onClick={() => setMode('remove')}
        >
          Remove…
        </button>
      )}
    </div>
  );
}

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
    {
      id: 'actions',
      header: 'Manage',
      cell: (row) => <ConnectionActions row={row} onToast={pushToasts} />,
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
            {BASE_URL_LABEL[provider]}
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
              provider === 'gitea'
                ? 'https://git.example.com'
                : provider === 'gitlab'
                  ? 'leave blank for gitlab.com'
                  : 'leave blank for GitHub'
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
                : `Gitea access token (${SCOPES.gitea})`}
          </label>
          {OPTIONAL_SCOPES[provider] ? (
            <p className="text-xs text-fg-faint" data-testid="connection-optional-scopes">
              {OPTIONAL_SCOPES[provider]}
            </p>
          ) : null}
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

      {/* A removed connection holds no token to list repositories with. */}
      {items
        .filter((c) => c.status !== 'removed')
        .map((c) => (
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
