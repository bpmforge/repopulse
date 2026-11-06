import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { docsUrl } from '../../lib/docs.js';
import { expiryState, expiryWords } from '../../widgets/admin/CiTokenExpiry.js';

// Settings → CI tokens (W20-08, UX_TODO FND-17).
//
// The API (W18-18) could mint, list and revoke CI tokens, and the only way to
// call it was curl with a copied session cookie — so the documented CI pull
// had no on-ramp. This screen is that on-ramp: create with a repository scope
// and an expiry, see the secret ONCE, list by prefix and last use, revoke.
//
// The secret lives only in this component's state after the create call; it
// is never put in the query cache, so leaving the page drops it for good.

export const Route = createFileRoute('/admin/ci-tokens')({ component: CiTokens });

export interface CiTokenRow {
  id: number;
  name: string;
  prefix: string;
  scope: string;
  repo_ids: number[];
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface Minted {
  id: number | null;
  name: string;
  token: string;
  prefix: string;
  repo_ids: number[];
  expires_at: string;
}

interface RepoRow {
  id: number;
  org: string;
  name: string;
}

const TOKENS = { endpoint: '/admin/ci-tokens' } as const;
/** The API's ceiling (MAX_EXPIRY_DAYS): a token outliving a year is one nobody remembers minting. */
export const CI_TOKEN_MAX_DAYS = 365;

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function CiTokens() {
  const tokens = useApiQuery<{ items: CiTokenRow[] }>(TOKENS);
  const repos = useApiQuery<{ items: RepoRow[] }>({ endpoint: '/repos' });
  const create = useApiMutation<
    { name: string; repo_ids: number[]; expires_in_days: number },
    Minted
  >({ ...TOKENS, method: 'POST' }, { invalidate: [queryKeyFor(TOKENS)] });

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [days, setDays] = useState('90');
  const [minted, setMinted] = useState<Minted | null>(null);

  const daysN = Number(days);
  const daysOk = Number.isInteger(daysN) && daysN >= 1 && daysN <= CI_TOKEN_MAX_DAYS;
  const canCreate = name.trim().length > 0 && picked.length > 0 && daysOk && !create.isPending;
  const repoName = (id: number) => {
    const r = repos.data?.items.find((x) => x.id === id);
    return r ? `${r.org}/${r.name}` : `#${id}`;
  };
  const items = tokens.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="admin-ci-tokens">
      <WidgetFrame title="Create a CI token" state="ready" testId="ci-token-create">
        <form
          className="form-narrow flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canCreate) return;
            setMinted(null);
            create.mutate(
              { name: name.trim(), repo_ids: picked, expires_in_days: daysN },
              {
                onSuccess: (m) => {
                  setMinted(m);
                  setName('');
                  setPicked([]);
                },
              },
            );
          }}
        >
          <p className="text-xs text-fg-muted">
            A CI token lets a pipeline read the findings on its pull requests, and nothing else. It
            reads only the repositories you tick, expires, and is shown once.{' '}
            <a
              href={docsUrl('/docs/CI_INTEGRATION.md')}
              className="text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              How the CI pull works
            </a>
          </p>
          <label htmlFor="ci-token-name" className="flex flex-col gap-1 text-xs text-fg-muted">
            Name (where it is used)
            <input
              id="ci-token-name"
              className="panel px-2 py-1 text-sm"
              data-testid="ci-token-name"
              placeholder="payments-api CI"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-fg-muted">Repositories it may read</legend>
            {repos.isLoading && <p className="text-xs text-fg-muted">Loading repositories…</p>}
            {repos.data && repos.data.items.length === 0 && (
              <p className="text-xs text-fg-muted">
                No repositories yet. Add one under Connections first.
              </p>
            )}
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {(repos.data?.items ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid={`ci-token-repo-${r.id}`}
                    checked={picked.includes(r.id)}
                    onChange={(e) =>
                      setPicked(
                        e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id),
                      )
                    }
                  />
                  {r.org}/{r.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="ci-token-days" className="flex w-40 flex-col gap-1 text-xs text-fg-muted">
            Expires after (days, 1-{CI_TOKEN_MAX_DAYS})
            <input
              id="ci-token-days"
              type="number"
              min={1}
              max={CI_TOKEN_MAX_DAYS}
              className="panel px-2 py-1 text-sm"
              data-testid="ci-token-days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={!canCreate}
              className="btn-primary rounded-md px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="ci-token-submit"
            >
              {create.isPending ? 'Creating…' : 'Create token'}
            </button>
          </div>
          <ErrorNote error={create.error} testId="ci-token-create-error" />
        </form>
        {minted && (
          <div
            className="mt-3 flex flex-col gap-2 rounded-md border border-accent p-3 text-sm"
            role="status"
            data-testid="ci-token-minted"
          >
            <p className="font-medium">
              Copy this now. It is not shown again: RepoPulse keeps only a hash.
            </p>
            <code className="break-all font-mono text-xs" data-testid="ci-token-secret">
              {minted.token}
            </code>
            <p className="text-xs text-fg-muted">
              Store it as a CI secret named <code className="font-mono">REPOPULSE_TOKEN</code>.
              Reads {minted.repo_ids.map(repoName).join(', ')} until {day(minted.expires_at)}.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="ci-token-copy"
                onClick={() => void navigator.clipboard?.writeText(minted.token)}
              >
                Copy
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="ci-token-dismiss"
                onClick={() => setMinted(null)}
              >
                I have stored it
              </button>
            </div>
          </div>
        )}
      </WidgetFrame>

      <WidgetFrame
        title="CI tokens"
        state={frameState({
          isLoading: tokens.isLoading,
          isError: tokens.isError,
          isEmpty: items.length === 0,
        })}
        error={tokens.error}
        emptyMessage="No CI tokens yet. Create one above to let a pipeline read pull request findings."
        testId="ci-token-list"
      >
        <table className="table-plain w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">Repositories</th>
              <th scope="col">Expires</th>
              <th scope="col">Last used</th>
              <th scope="col" className="text-right">
                <span className="sr-only">Revoke</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr
                key={t.id}
                className={`border-t border-border ${expiryState(t) ? 'bg-warn/10' : ''}`}
                data-testid={`ci-token-row-${t.id}`}
              >
                <th scope="row" className="text-left font-normal">
                  {t.name}
                </th>
                <td className="font-mono text-xs">{t.prefix}…</td>
                <td className="text-xs">{t.repo_ids.map(repoName).join(', ')}</td>
                <td className="text-xs">
                  {day(t.expires_at)}
                  {/* W20-15 (UX_TODO X-19): due rows say so, in words. */}
                  {expiryState(t) && t.expires_at && (
                    <span
                      className="ml-1 font-medium text-warn"
                      data-testid={`ci-token-due-${t.id}`}
                    >
                      ({expiryWords(t.expires_at)})
                    </span>
                  )}
                </td>
                <td className="text-xs">{t.last_used_at ? day(t.last_used_at) : 'never'}</td>
                <td className="text-right">
                  {t.revoked_at ? (
                    <span className="text-xs text-fg-muted">revoked {day(t.revoked_at)}</span>
                  ) : (
                    <RevokeButton token={t} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>
    </div>
  );
}

/** One row's revoke, asked twice: a pipeline using it fails on its next run. */
function RevokeButton({ token }: { token: CiTokenRow }) {
  const [asking, setAsking] = useState(false);
  const revoke = useApiMutation<undefined, unknown>(
    { endpoint: '/admin/ci-tokens/{id}', path: { id: token.id }, method: 'DELETE' },
    { invalidate: [queryKeyFor(TOKENS)] },
  );
  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      {asking ? (
        <span className="flex items-center gap-1">
          Any pipeline using it fails from its next run.
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-crit focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`ci-token-revoke-yes-${token.id}`}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(undefined, { onSettled: () => setAsking(false) })}
          >
            Revoke
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => setAsking(false)}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="rounded-md border border-border px-2 py-0.5 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid={`ci-token-revoke-${token.id}`}
          onClick={() => setAsking(true)}
        >
          Revoke
        </button>
      )}
      <ErrorNote error={revoke.error} testId={`ci-token-revoke-error-${token.id}`} />
    </div>
  );
}
