import { useEffect, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { summarizeRole, type EgressLink, type EgressProvider } from './egress.js';

// Settings → Models → Routing (W19-02).
//
// Which connection and model serves which ROLE, as an ordered fallback chain,
// plus the local-only switch. A plain settings section: the guided wizard is
// W19-07. Two things this screen is careful about:
//
//   FALLBACK IS FOR PROVIDER FAILURES, and the screen says so. A chain moves to
//   the next link when a connection is down or refusing — never because a model
//   answered badly. People assume otherwise, and an assumption here changes
//   where their diffs go.
//
//   LOCAL-ONLY'S REFUSAL IS SHOWN IN FULL. The API names the role and the
//   connection that would leave the network; this screen prints that sentence
//   rather than a generic "invalid".

const ROUTING = { endpoint: '/admin/llm-routing' } as const;

interface ChainLink {
  provider_id: number;
  provider_name: string | null;
  model: string | null;
  host?: string | null;
  leaves_network?: boolean | null;
}
interface RoleRow {
  role: string;
  chain: ChainLink[];
}
interface ProviderOption {
  id: number;
  name: string;
  kind: string;
  model: string;
  enabled: boolean;
  /** Where it sends, by the egress audit's rule (the API's describeEndpoint). */
  host?: string | null;
  leaves_network?: boolean | null;
}
interface RoutingState {
  local_only: boolean;
  roles: RoleRow[];
  providers: ProviderOption[];
}

const ROLE_LABEL: Record<string, string> = {
  security: 'Security',
  performance: 'Performance',
  code_health: 'Code health',
  best_practices: 'Best practices',
  ai_slop: 'AI slop',
  test_coverage: 'Test coverage',
  triage: 'Triage',
  patch: 'Patch',
  triage_fast: 'Quick first look at rule hits (optional, a smaller faster model)',
};

/**
 * W22-03: roles used only when routed. With no chain nothing is sent for them
 * (never the shared pool), and "one connection for every role" leaves them be.
 */
const OPTIONAL_ROLES = new Set(['triage_fast']);
const OPTIONAL_UNROUTED_TEXT =
  'Not used: with no chain, rule hits go straight to Triage. Add a smaller, faster model here and it looks at each rule hit first; only its confident "likely false positive" answers are kept, everything else goes on to Triage.';

/**
 * What will actually happen for a role, in one sentence (from what is on screen, not
 * a promise about a model): the chain in order with the model each link will use, or
 * the shared pool when no chain is set.
 */
export function effectiveChainText(
  chain: ChainLink[],
  providers: ProviderOption[],
  localOnly: boolean,
): string {
  if (chain.length === 0) {
    if (providers.length === 0)
      return 'No connection is set up, so this role will skip and say so.';
    if (!localOnly)
      return (
        'Uses the shared pool: ' + providers.map((p) => `${p.name} · ${p.model}`).join(', ') + '.'
      );
    // W20-06 (UX_TODO AI-05): under local-only the pool really is limited, so
    // the list is too. It used to name every enabled connection, hosted ones
    // included, right after "limited to connections on your network".
    const home = providers.filter((p) => p.leaves_network === false);
    return home.length === 0
      ? 'Local-only is on and no connection is on your network, so this role will skip and say so.'
      : 'Uses the shared pool, limited to connections on your network (local-only is on): ' +
          home.map((p) => `${p.name} · ${p.model}`).join(', ') +
          '.';
  }
  const label = (l: ChainLink): string => {
    const known = providers.find((p) => p.id === l.provider_id);
    const model = l.model || known?.model || 'its own model';
    return `${l.provider_name ?? `connection ${l.provider_id}`} · ${model}`;
  };
  const [first, ...rest] = chain;
  return rest.length === 0
    ? `Uses ${label(first!)}. If it is down or refuses, the role skips and says so.`
    : `Tries ${label(first!)}; if it is down or refuses, then ${rest.map(label).join(', then ')}.`;
}

/**
 * The chain as the egress summary needs it (W20-06, UX_TODO AI-05). A link added
 * on this screen has no host yet, so it takes its connection's, as reported by
 * the server, never a guess from the name.
 */
function egressLinks(chain: ChainLink[], providers: ProviderOption[]): EgressLink[] {
  return chain.map((l) => {
    const p = providers.find((x) => x.id === l.provider_id);
    return {
      provider_id: l.provider_id,
      provider_name: l.provider_name,
      host: p?.host ?? l.host ?? null,
      leaves_network: p?.leaves_network ?? l.leaves_network ?? null,
    };
  });
}

const EGRESS_MARK = {
  stays: '✓ Stays on your network.',
  gateway: '⚠ Through a gateway.',
  leaves: '⚠ Leaves your network.',
  unavailable: '— Not used.',
} as const;

export function LlmRouting() {
  const query = useApiQuery<RoutingState>(ROUTING);
  const [localOnly, setLocalOnly] = useState(false);
  const [chains, setChains] = useState<Record<string, ChainLink[]>>({});
  // What was last saved, so "Saved." holds until the next edit even before the
  // refetched routing arrives.
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [confirmStrip, setConfirmStrip] = useState(false);

  // Re-seed the editor whenever the server's copy changes (first load, save).
  useEffect(() => {
    if (!query.data) return;
    setLocalOnly(query.data.local_only);
    setChains(Object.fromEntries(query.data.roles.map((r) => [r.role, r.chain])));
  }, [query.data]);

  const save = useApiMutation<Record<string, unknown>, unknown>(
    { endpoint: '/admin/llm-routing', method: 'PUT' },
    { invalidate: [queryKeyFor(ROUTING)] },
  );

  // W20-11 (UX_TODO AI-24): edits wait for "Save routing", and nothing said so;
  // the Local only tick read as instant, and leaving the page dropped the edits.
  const serverChains = Object.fromEntries((query.data?.roles ?? []).map((r) => [r.role, r.chain]));
  const norm = (c: Record<string, ChainLink[]>) =>
    JSON.stringify(
      Object.keys(c)
        .sort()
        .map((role) => [role, (c[role] ?? []).map((l) => [l.provider_id, l.model || null])])
        .filter(([, chain]) => (chain as unknown[]).length > 0),
    );
  const currentKey = JSON.stringify([localOnly, norm(chains)]);
  const dirty =
    query.data !== undefined &&
    currentKey !== JSON.stringify([query.data.local_only, norm(serverChains)]) &&
    currentKey !== savedKey;
  const saved = savedKey !== null && savedKey === currentKey;
  // W20-16 (re-walk of UX_TODO AI-24): the warning covered closing the tab
  // only; moving to another screen inside the app dropped the edits silently.
  // The router's blocker asks on both, like a saved view's editor does.
  useBlocker({
    shouldBlockFn: () => !window.confirm('Leave Routing? Your unsaved changes will be lost.'),
    disabled: !dirty,
    enableBeforeUnload: dirty,
  });
  const discard = () => {
    if (!query.data) return;
    setLocalOnly(query.data.local_only);
    setChains(serverChains);
    setConfirmStrip(false);
  };

  // W20-11 (UX_TODO AI-76): ticking Local only with hosted links still in the
  // chains was refused on Save (a 422 listing them), and each link then had to
  // be found and removed by hand across up to eight roles. They are marked
  // here, and one confirmed action removes them and saves.
  const leaves = (id: number) =>
    (query.data?.providers ?? []).find((p) => p.id === id)?.leaves_network === true;
  const offNetwork = Object.entries(chains)
    .map(([role, chain]) => ({ role, links: chain.filter((l) => leaves(l.provider_id)) }))
    .filter((r) => r.links.length > 0);

  const providers = (query.data?.providers ?? []).filter((p) => p.enabled);
  // W20-06 (UX_TODO AI-03): a switched-off connection is not offered in the
  // pickers, and that used to be silent. It is named, with where to fix it.
  const switchedOff = (query.data?.providers ?? []).filter((p) => !p.enabled);
  const egressProviders: EgressProvider[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    host: p.host ?? null,
    leaves_network: p.leaves_network ?? null,
  }));
  const roles = query.data?.roles ?? [];

  const update = (role: string, next: ChainLink[]) => {
    setChains((c) => ({ ...c, [role]: next }));
  };

  function body(from: Record<string, ChainLink[]> = chains): Record<string, unknown> {
    return {
      local_only: localOnly,
      roles: Object.fromEntries(
        Object.entries(from)
          .filter(([, chain]) => chain.length > 0)
          .map(([role, chain]) => [
            role,
            chain.map((l) => ({ provider_id: l.provider_id, model: l.model || null })),
          ]),
      ),
    };
  }

  return (
    <WidgetFrame
      title="Routing"
      state={frameState({
        isLoading: query.isLoading,
        isError: query.isError,
        isEmpty: false,
      })}
      {...(query.error ? { errorMessage: query.error.message } : {})}
      onRetry={() => void query.refetch()}
    >
      <div data-testid="llm-routing" id="model-routing" className="flex flex-col gap-3">
        <p className="text-xs text-fg-muted">
          Choose which connection and model handles each kind of analysis. A role with no chain uses
          your connections as a shared pool. If a connection is down or refuses a request, the next
          one in the chain is tried; a model that answers badly is <strong>not</strong> retried on
          another model. Changes apply within about a minute.
        </p>

        <label className="flex items-start gap-2 text-xs text-fg">
          <input
            type="checkbox"
            data-testid="routing-local-only"
            checked={localOnly}
            onChange={(e) => {
              setLocalOnly(e.target.checked);
            }}
            className="mt-0.5"
          />
          <span>
            <strong>Local only.</strong> Refuse any role that would send code outside my network
            (including Tier-3, the Claude API). Roles without a chain use only my local connections.
          </span>
        </label>

        {localOnly && offNetwork.length > 0 ? (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs"
            data-testid="routing-local-only-conflict"
          >
            <p>
              <strong>Local only cannot be saved yet:</strong>{' '}
              {offNetwork.reduce((n, r) => n + r.links.length, 0)} link
              {offNetwork.reduce((n, r) => n + r.links.length, 0) === 1 ? '' : 's'} below leave your
              network, in {offNetwork.map((r) => ROLE_LABEL[r.role] ?? r.role).join(', ')}. They are
              marked &ldquo;will be removed&rdquo;.
            </p>
            {confirmStrip ? (
              <p>
                Remove them from{' '}
                {offNetwork
                  .map(
                    (r) =>
                      `${ROLE_LABEL[r.role] ?? r.role} (${r.links.map((l) => l.provider_name ?? `connection ${l.provider_id}`).join(', ')})`,
                  )
                  .join('; ')}{' '}
                and save with Local only on? A role left with no link uses your local connections.
              </p>
            ) : null}
            <div className="flex gap-1.5">
              {confirmStrip ? (
                <>
                  <button
                    type="button"
                    data-testid="routing-strip-do"
                    disabled={save.isPending}
                    onClick={() => {
                      const stripped = Object.fromEntries(
                        Object.entries(chains).map(([role, chain]) => [
                          role,
                          chain.filter((l) => !leaves(l.provider_id)),
                        ]),
                      );
                      setChains(stripped);
                      save.mutate(body(stripped), {
                        onSuccess: () => {
                          setSavedKey(JSON.stringify([localOnly, norm(stripped)]));
                          setConfirmStrip(false);
                        },
                      });
                    }}
                    className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10 disabled:opacity-50"
                  >
                    Remove and save
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmStrip(false)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="routing-strip"
                  onClick={() => setConfirmStrip(true)}
                  className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10"
                >
                  Remove off-network links and turn on Local only…
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* W20-11 (UX_TODO AI-26): one model for every role took eight
            separate "Add a connection…" picks. */}
        {providers.length > 0 ? (
          <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            Use one connection for every role:
            <select
              data-testid="routing-apply-all"
              value=""
              onChange={(e) => {
                const p = providers.find((x) => x.id === Number(e.target.value));
                if (!p) return;
                // An optional role keeps its own chain (W22-03): routing it to
                // the same model as Triage would only ask that model twice.
                setChains((c) =>
                  Object.fromEntries(
                    roles.map(({ role }) => [
                      role,
                      OPTIONAL_ROLES.has(role)
                        ? (c[role] ?? [])
                        : [{ provider_id: p.id, provider_name: p.name, model: null }],
                    ]),
                  ),
                );
              }}
              className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs"
            >
              <option value="">Choose…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-fg-faint">
              Replaces every chain with that one connection (the optional quick first look is left
              as it is); nothing is saved until Save routing.
            </span>
          </label>
        ) : null}

        {switchedOff.length > 0 ? (
          <p className="text-xs text-fg-muted" data-testid="routing-switched-off">
            Switched off, so not offered below: {switchedOff.map((p) => p.name).join(', ')}. Turn a
            connection back on with Edit in Configured providers.
          </p>
        ) : null}

        <table className="table-plain w-full text-sm" data-testid="routing-table">
          <caption className="sr-only">Connection chain per role</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Role</th>
              <th scope="col">Chain (first choice first)</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(({ role }) => {
              const chain = chains[role] ?? [];
              return (
                <tr
                  key={role}
                  className="border-t border-border align-top"
                  data-testid={`routing-row-${role}`}
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {ROLE_LABEL[role] ?? role}
                  </th>
                  <td className="py-2">
                    {chain.length === 0 ? null : (
                      <ol className="flex flex-col gap-1">
                        {chain.map((link, i) => (
                          <li
                            key={`${link.provider_id}-${i}`}
                            className="flex flex-wrap items-center gap-2 text-xs"
                          >
                            <span className="text-fg-muted">{i + 1}.</span>
                            <span>{link.provider_name ?? `connection ${link.provider_id}`}</span>
                            {localOnly && leaves(link.provider_id) ? (
                              <span
                                className="font-semibold text-warn"
                                data-testid={`routing-will-remove-${role}-${i}`}
                              >
                                leaves your network: will be removed
                              </span>
                            ) : null}
                            <input
                              aria-label={`Model override for ${ROLE_LABEL[role] ?? role} link ${i + 1}`}
                              data-testid={`routing-model-${role}-${i}`}
                              value={link.model ?? ''}
                              placeholder="connection's model"
                              onChange={(e) =>
                                update(
                                  role,
                                  chain.map((l, j) =>
                                    j === i ? { ...l, model: e.target.value } : l,
                                  ),
                                )
                              }
                              className="w-40 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono"
                            />
                            <button
                              type="button"
                              aria-label={`Move link ${i + 1} up`}
                              disabled={i === 0}
                              onClick={() => {
                                const next = [...chain];
                                [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                                update(role, next);
                              }}
                              className="underline disabled:opacity-40"
                            >
                              ↑
                            </button>
                            {/* W20-11 (UX_TODO AI-25): a link could go up but not down. */}
                            <button
                              type="button"
                              aria-label={`Move link ${i + 1} down`}
                              data-testid={`routing-down-${role}-${i}`}
                              disabled={i === chain.length - 1}
                              onClick={() => {
                                const next = [...chain];
                                [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                                update(role, next);
                              }}
                              className="underline disabled:opacity-40"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              aria-label={`Remove link ${i + 1}`}
                              data-testid={`routing-remove-${role}-${i}`}
                              onClick={() =>
                                update(
                                  role,
                                  chain.filter((_, j) => j !== i),
                                )
                              }
                              className="underline"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p
                      className="mt-1 text-xs text-fg-muted"
                      data-testid={`routing-effective-${role}`}
                    >
                      {chain.length === 0 && OPTIONAL_ROLES.has(role)
                        ? OPTIONAL_UNROUTED_TEXT
                        : effectiveChainText(chain, providers, localOnly)}
                    </p>
                    {/* W20-06 (UX_TODO AI-05): whether code leaves the network,
                        from the same summary the wizard's review uses. */}
                    {(() => {
                      if (chain.length === 0 && OPTIONAL_ROLES.has(role)) {
                        return (
                          <p
                            className="mt-0.5 text-xs text-fg"
                            data-testid={`routing-egress-${role}`}
                            data-tone="unavailable"
                          >
                            <span className="font-semibold">{EGRESS_MARK.unavailable}</span> Nothing
                            is sent for this role.
                          </p>
                        );
                      }
                      const e = summarizeRole({
                        chain: egressLinks(chain, providers),
                        providers: egressProviders,
                        localOnly,
                      });
                      return (
                        <p
                          className="mt-0.5 text-xs text-fg"
                          data-testid={`routing-egress-${role}`}
                          data-tone={e.tone}
                        >
                          <span className="font-semibold">{EGRESS_MARK[e.tone]}</span> {e.text}
                        </p>
                      );
                    })()}
                    <select
                      aria-label={`Add a connection to ${ROLE_LABEL[role] ?? role}`}
                      data-testid={`routing-add-${role}`}
                      value=""
                      onChange={(e) => {
                        const p = providers.find((x) => x.id === Number(e.target.value));
                        if (p)
                          update(role, [
                            ...chain,
                            { provider_id: p.id, provider_name: p.name, model: null },
                          ]);
                      }}
                      className="mt-1 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs"
                    >
                      <option value="">Add a connection…</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="routing-save"
            disabled={save.isPending}
            onClick={() => {
              const sent = currentKey;
              setSavedKey(null);
              save.mutate(body(), { onSuccess: () => setSavedKey(sent) });
            }}
            className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save routing'}
          </button>
          {dirty && !save.isPending ? (
            <>
              <span className="text-xs font-semibold text-warn" data-testid="routing-unsaved">
                Unsaved changes: nothing above applies until you save.
              </span>
              <button
                type="button"
                data-testid="routing-discard"
                onClick={discard}
                className="text-xs underline underline-offset-2"
              >
                Discard
              </button>
            </>
          ) : null}
          {saved ? (
            <span role="status" data-testid="routing-saved" className="text-xs text-fg-muted">
              Saved.
            </span>
          ) : null}
        </div>
        {/* The API's own sentence, which names the role and connection. */}
        <ErrorNote error={save.error} testId="routing-error" />
        {(save.error as { detail?: string } | null)?.detail ? (
          <p className="text-xs text-crit" data-testid="routing-error-detail">
            {(save.error as { detail?: string }).detail}
          </p>
        ) : null}
      </div>
    </WidgetFrame>
  );
}
