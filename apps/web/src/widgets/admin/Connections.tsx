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
import { localDateTime } from '../../lib/time.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { errorDetailOf, requestIdOf } from '../../api/client.js';
import { errorToast, type Toast } from '../../components/store/uiStore.js';
import type { ConnectionList, ConnectionSummary } from './contracts.js';
import { RepoPicker } from './RepoPicker.js';
import { tokenExpiryText, tokenOwnerText } from './forge-token.js';

// Admin → Connections (UX_SPEC §4.i). This is the screen docs/INSTALL.md sends
// operators to, and the only way to connect an organization.

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

type Forge = 'github' | 'gitlab' | 'gitea';

/** The token field's placeholder, per forge (W20-14, UX_TODO INS-43). */
export const TOKEN_PLACEHOLDER: Record<Forge, string> = {
  github: 'ghp_… (classic) or github_pat_… (fine-grained)',
  gitlab: 'glpat-…',
  gitea: 'the 40-character token Gitea shows once',
};

/**
 * Fine-grained GitHub tokens name permissions, not scopes (W20-14, INS-26):
 * the label used to list only the classic scopes.
 */
export const GITHUB_FINE_GRAINED =
  'Fine-grained token: choose the repositories, then Repository permissions → Metadata, Contents, Pull requests, Issues and Commit statuses: Read-only (Webhooks: Read and write for live updates).';

/** The forge's own host when the row has no URL (W20-14, UX_TODO INS-43). */
export function connectionHost(provider: string, baseUrl: string | null): string {
  if (baseUrl) {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  }
  if (provider === 'github') return 'github.com';
  if (provider === 'gitlab') return 'gitlab.com';
  return 'no address set';
}

/**
 * "ada, 3 Oct 2026 14:02 (UTC)" (W20-22, UX_TODO ADM-50): whose credential a
 * connection was added with, so a replacement admin can find the one running
 * on a departing person's personal token.
 */
export function addedByText(row: { created_at?: string; created_by?: string | null }): string {
  if (!row.created_at) return '—';
  const who = row.created_by ?? 'a removed account';
  return `${who}, ${localDateTime(row.created_at)}`;
}

/** "GitHub · github.com" — what a picker and a row are called (INS-28). */
export function connectionLabel(provider: string, baseUrl: string | null): string {
  const name =
    provider === 'github'
      ? 'GitHub'
      : provider === 'gitlab'
        ? 'GitLab'
        : provider === 'gitea'
          ? 'Gitea'
          : provider;
  return `${name} · ${connectionHost(provider, baseUrl)}`;
}

/**
 * Where to create the token, on this forge (W20-14, UX_TODO INS-26). The
 * GitHub link pre-fills the classic scopes. Null when the address is unknown
 * (Gitea with no URL typed yet) or not a URL.
 */
export function tokenCreateUrl(provider: Forge, baseUrl: string): string | null {
  let origin: string;
  const typed = baseUrl.trim();
  if (typed) {
    try {
      const u = new URL(typed);
      // A GitHub Enterprise API root (…/api/v3) lives on the same origin as
      // its settings pages; strip any API path.
      origin = u.origin;
    } catch {
      return null;
    }
  } else if (provider === 'github') {
    origin = 'https://github.com';
  } else if (provider === 'gitlab') {
    origin = 'https://gitlab.com';
  } else {
    return null;
  }
  switch (provider) {
    case 'github':
      return `${origin}/settings/tokens/new?scopes=repo,read:org&description=RepoPulse`;
    case 'gitlab':
      return `${origin}/-/user_settings/personal_access_tokens?name=RepoPulse&scopes=read_api`;
    case 'gitea':
      return `${origin}/user/settings/applications`;
  }
}

/** A connection's status in words (W20-14, UX_TODO ADM-41). */
export function connectionStatusText(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'removed':
      return 'Removed — token wiped, repositories paused';
    default:
      return status.replace(/_/g, ' ');
  }
}

/** The Instance URL label names the real default per forge (W20-07, UX_TODO INS-73). */
export const BASE_URL_LABEL: Record<'github' | 'gitlab' | 'gitea', string> = {
  github:
    'Instance URL (optional — blank means github.com; for GitHub Enterprise Server give its address, e.g. https://ghe.example.com, and /api/v3 is added)',
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
      return 'The token works but can see no repositories. Check that its owner is a member of the organization, or that a fine-grained token includes the repositories.';
    // W20-07 (UX_TODO INS-64): the forge never judged the token in these
    // three, so none of them may tell the admin to replace it.
    case 'wrong_url':
      return 'The forge answered "not found" for the repository listing. The Instance URL is probably wrong — check it. For GitHub Enterprise Server, the server address is enough (/api/v3 is added for you).';
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
  return `Its ${repoCount} tracked repositor${repoCount === 1 ? 'y stops' : 'ies stop'} syncing and ${repoCount === 1 ? 'is' : 'are'} paused; history already collected stays on every dashboard. RepoPulse first deletes the webhooks it registered on those repositories, then wipes the token and webhook secret; any hook it cannot delete is named afterwards and refused from now on. Replace the token later to reconnect.`;
}

/**
 * The toast after removing a connection (W20-17): how many hooks were deleted
 * on the forge, and which repositories still need theirs removed by hand.
 */
export function removedMessage(res: {
  outcome: string;
  paused_repos: number;
  webhooks_removed?: number;
  webhook_failures?: { repo: string; error: string }[];
}): string {
  const removed = res.webhooks_removed ?? 0;
  const failures = res.webhook_failures ?? [];
  const head =
    res.outcome === 'deleted'
      ? 'Connection deleted'
      : `Connection removed — ${res.paused_repos} ${res.paused_repos === 1 ? 'repository' : 'repositories'} paused, history kept`;
  const hooks =
    removed > 0 ? `; ${removed} webhook${removed === 1 ? '' : 's'} deleted on the forge` : '';
  const left =
    failures.length > 0
      ? `. Delete the RepoPulse webhook by hand on: ${failures
          .slice(0, 5)
          .map((f) => f.repo)
          .join(', ')}${failures.length > 5 ? ` and ${failures.length - 5} more` : ''}`
      : '';
  return `${head}${hooks}${left}`;
}

/**
 * "Auto-add new repositories" per connection (W20-17, UX_TODO INS-09). On, the
 * nightly sync tracks every repository created on the forge since the last
 * one; off, nothing new is tracked until someone picks it. Never untracks.
 */
function AutoAddToggle({ row, onToast }: { row: Row; onToast: (t: Toast[]) => void }) {
  const toggle = useApiMutation<{ enabled: boolean }, { id: number; auto_add: boolean }>(
    { endpoint: '/connections/{id}/auto-add', path: { id: row.id }, method: 'PUT' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  if (row.status !== 'active') return <span className="text-fg-muted">—</span>;
  const on = row.auto_add === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={toggle.isPending}
      title={
        on
          ? 'New repositories on this connection are tracked by the nightly sync. Click to stop.'
          : 'Track repositories created on the forge later, at the nightly sync.'
      }
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-testid={`connection-auto-add-${row.id}`}
      onClick={() =>
        toggle.mutate(
          { enabled: !on },
          { onError: (err: Error) => onToast([errorToast(`conn-aa-${row.id}-err`, err)]) },
        )
      }
    >
      {on ? 'Auto-add: on' : 'Auto-add: off'}
    </button>
  );
}

/** What switching "scheduled sync only" did, for the toast (W20-19, INS-69). */
export function scheduledSyncMessage(res: {
  scheduled_sync_only: boolean;
  webhooks_removed: number;
  webhooks_registered: number;
  webhook_failures: { repo: string; error: string }[];
}): string {
  const failed = res.webhook_failures;
  const tail =
    failed.length === 0
      ? ''
      : ` Not done for ${failed
          .slice(0, 3)
          .map((f) => `${f.repo} (${f.error})`)
          .join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}.`;
  if (res.scheduled_sync_only) {
    return `Scheduled sync only: ${res.webhooks_removed} webhook${res.webhooks_removed === 1 ? '' : 's'} removed. These repositories now update with the nightly sync.${tail}`;
  }
  return `Webhooks on: ${res.webhooks_registered} registered, so changes arrive within a minute again.${tail}`;
}

/**
 * "Scheduled sync only" per connection (W20-19, UX_TODO INS-69; decision
 * 2026-10-20). For an install the forge cannot reach: no webhooks are
 * registered (switching it on removes the ones already there) and the nightly
 * reconcile keeps the repositories current.
 */
function ScheduledSyncToggle({ row, onToast }: { row: Row; onToast: (t: Toast[]) => void }) {
  const toggle = useApiMutation<
    { enabled: boolean },
    {
      id: number;
      scheduled_sync_only: boolean;
      webhooks_removed: number;
      webhooks_registered: number;
      webhook_failures: { repo: string; error: string }[];
    }
  >(
    { endpoint: '/connections/{id}/scheduled-sync', path: { id: row.id }, method: 'PUT' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  if (row.status !== 'active') return <span className="text-fg-muted">—</span>;
  const on = row.scheduled_sync_only === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={toggle.isPending}
      title={
        on
          ? 'No webhooks: changes arrive with the nightly sync. Click to register webhooks again.'
          : 'For an install the forge cannot reach: remove this connection’s webhooks and rely on the nightly sync.'
      }
      className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      data-testid={`connection-scheduled-${row.id}`}
      onClick={() =>
        toggle.mutate(
          { enabled: !on },
          {
            onError: (err: Error) => onToast([errorToast(`conn-sched-${row.id}-err`, err)]),
            onSuccess: (res) =>
              onToast([
                {
                  id: `conn-sched-${row.id}`,
                  tone: res.webhook_failures.length === 0 ? 'ok' : 'warn',
                  message: scheduledSyncMessage(res),
                },
              ]),
          },
        )
      }
    >
      {on ? 'Scheduled sync only' : 'Webhooks'}
    </button>
  );
}

/**
 * Replace token / Remove, per connection row (W20-07, UX_TODO INS-08).
 *
 * Before this a connection could only be created: a wrong-but-valid token, a
 * rotated one, or a lost TOKEN_ENC_KEY ("must be re-entered") had no recovery
 * path short of a second connection. Each row owns its mutations because the
 * URL carries the id (same reason as RepoPicker and Members).
 */
function ConnectionActions({
  row,
  onToast,
  pickerOpen,
  onTogglePicker,
}: {
  row: Row;
  onToast: (toasts: Toast[]) => void;
  pickerOpen: boolean;
  onTogglePicker: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'rekey' | 'remove'>('idle');
  const [token, setToken] = useState('');
  const rekey = useApiMutation<{ credential: string }, { id: number; fingerprint: string }>(
    { endpoint: '/connections/{id}', path: { id: row.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const remove = useApiMutation<
    undefined,
    {
      outcome: string;
      paused_repos: number;
      webhooks_removed?: number;
      webhook_failures?: { repo: string; error: string }[];
    }
  >(
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
                  const failures = res.webhook_failures ?? [];
                  onToast([
                    {
                      id: `conn-rm-${row.id}`,
                      tone: failures.length > 0 ? 'warn' : 'ok',
                      message: removedMessage(res),
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
    <div className="flex flex-wrap gap-1.5">
      {/* INS-75: the picker lists the forge's repositories live, so it opens
          on request rather than on every visit to Settings. */}
      {row.status !== 'removed' && (
        <button
          type="button"
          aria-expanded={pickerOpen}
          className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid={`connection-pick-${row.id}`}
          onClick={onTogglePicker}
        >
          {pickerOpen ? 'Hide repositories' : 'Choose repositories…'}
        </button>
      )}
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        data-testid={`connection-rekey-${row.id}`}
        onClick={() => setMode('rekey')}
      >
        {row.status === 'removed' ? 'Reconnect…' : 'Replace token…'}
      </button>
      {row.status === 'active' && row.repo_count > 0 && row.scheduled_sync_only !== true && (
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
  // W20-19 (UX_TODO INS-69): no webhooks for an install the forge cannot reach.
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  // INS-75: which connections' pickers are open, and which one just connected
  // (INS-27: it opens by itself and takes focus).
  const [openPickers, setOpenPickers] = useState<Set<number>>(new Set());
  const [justConnected, setJustConnected] = useState<number | null>(null);
  const pushToasts = useUiStore((s) => s.pushToasts);
  const togglePicker = (id: number) =>
    setOpenPickers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { data, isLoading, isError, error, refetch } = useApiQuery<ConnectionList>(LIST);

  const create = useApiMutation<
    {
      provider: string;
      auth_kind: string;
      credential: string;
      base_url?: string;
      scheduled_sync_only?: boolean;
    },
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
      // INS-43: a blank row shows the forge's real host, not "server default".
      cell: (row) => (
        <span className="text-fg-muted">{connectionHost(row.provider, row.base_url)}</span>
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
        <SeverityBadge
          severity={row.status === 'active' ? 'low' : 'medium'}
          label={connectionStatusText(row.status)}
        />
      ),
    },
    {
      id: 'added',
      header: 'Added',
      cell: (row) => (
        <span className="text-xs text-fg-muted" data-testid={`connection-added-${row.id}`}>
          {addedByText(row)}
        </span>
      ),
    },
    {
      id: 'token',
      header: 'Token',
      // W20-25 (UX_TODO ADM-50): whose forge account the token is and when it
      // stops working, as the forge reported at connect time. Never the token.
      cell: (row) => (
        <span className="flex flex-col text-xs" data-testid={`connection-token-${row.id}`}>
          <span>{tokenOwnerText(row)}</span>
          <span
            className={
              row.token_expiry === 'expired' || row.token_expiry === 'expiring'
                ? 'font-medium text-warn'
                : 'text-fg-muted'
            }
            data-expiry={row.token_expiry ?? 'unknown'}
          >
            {tokenExpiryText(row)}
          </span>
        </span>
      ),
    },
    {
      id: 'repos',
      header: 'Repos',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{row.repo_count}</span>,
    },
    {
      id: 'auto_add',
      header: 'New repos',
      cell: (row) => <AutoAddToggle row={row} onToast={pushToasts} />,
    },
    {
      id: 'updates',
      header: 'Updates',
      cell: (row) => <ScheduledSyncToggle row={row} onToast={pushToasts} />,
    },
    {
      id: 'actions',
      header: 'Manage',
      cell: (row) => (
        <ConnectionActions
          row={row}
          onToast={pushToasts}
          pickerOpen={openPickers.has(row.id)}
          onTogglePicker={() => togglePicker(row.id)}
        />
      ),
    },
  ];
  const tokenUrl = tokenCreateUrl(provider, baseUrl);

  return (
    <div className="flex flex-col gap-4" data-testid="admin-connections">
      <WidgetFrame
        title="Connect a forge"
        state="ready"
        definitionHref={docsUrl('/docs/INSTALL.md#connect-your-forge')}
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
                ...(scheduledOnly ? { scheduled_sync_only: true } : {}),
              },
              {
                onSuccess: (res) => {
                  // Clear immediately: a token left in a form field survives in
                  // the DOM and in any screenshot the operator takes next.
                  setCredential('');
                  setScheduledOnly(false);
                  // INS-27 / INS-44: say what comes next instead of the raw
                  // status, open the new connection's picker and move focus
                  // there. The toast duplicated this line, so it is gone.
                  setSubmitted('Connected. Now choose which repositories to track below.');
                  setOpenPickers((prev) => new Set(prev).add(res.id));
                  setJustConnected(res.id);
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
            // INS-25: Gitea has no default host, so the browser says so before
            // the server has to.
            required={provider === 'gitea'}
            aria-required={provider === 'gitea'}
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
                  : 'blank for github.com, or https://ghe.example.com'
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
          {provider === 'github' ? (
            <p className="text-xs text-fg-faint" data-testid="connection-fine-grained">
              {GITHUB_FINE_GRAINED}
            </p>
          ) : null}
          {/* INS-26: straight to the page that makes the token. */}
          {tokenUrl ? (
            <a
              href={tokenUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit text-xs text-accent underline-offset-2 hover:underline"
              data-testid="connection-token-link"
            >
              Create a token on {connectionHost(provider, baseUrl.trim() || null)} ↗
            </a>
          ) : null}
          <input
            id="connection-credential"
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={TOKEN_PLACEHOLDER[provider]}
            className="panel px-2 py-1 text-sm"
            data-testid="connection-credential"
          />
          <label className="flex items-start gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={scheduledOnly}
              onChange={(e) => setScheduledOnly(e.target.checked)}
              data-testid="connection-scheduled-only"
            />
            <span>
              Scheduled sync only (no webhooks). Choose this when the forge cannot reach this
              install, e.g. a private server: no webhooks are registered on your repositories, and
              changes appear after the nightly sync instead of within a minute.
            </span>
          </label>
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
              <span className="text-xs text-fg-muted" role="status" data-testid="connection-result">
                {submitted}
              </span>
            )}
          </div>
        </form>
      </WidgetFrame>

      {/* A removed connection holds no token to list repositories with.
          INS-75: only the pickers someone opened; each one asks the forge. */}
      {items
        .filter((c) => c.status !== 'removed' && openPickers.has(c.id))
        .map((c) => (
          <RepoPicker
            key={c.id}
            connectionId={c.id}
            connectionsKey={queryKeyFor(LIST)}
            sourceLabel={connectionLabel(c.provider, c.base_url)}
            autoFocus={justConnected === c.id}
          />
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
        emptyMessage="No connections yet. Add a credential above to connect your organization."
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
