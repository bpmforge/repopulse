import { useEffect, useState } from 'react';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Models → Routing (W19-02).
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
};

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
    return localOnly
      ? 'Uses the shared pool, limited to connections on your network (local-only is on): ' +
          providers.map((p) => `${p.name} · ${p.model}`).join(', ') +
          '.'
      : 'Uses the shared pool: ' + providers.map((p) => `${p.name} · ${p.model}`).join(', ') + '.';
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

export function LlmRouting() {
  const query = useApiQuery<RoutingState>(ROUTING);
  const [localOnly, setLocalOnly] = useState(false);
  const [chains, setChains] = useState<Record<string, ChainLink[]>>({});
  const [saved, setSaved] = useState(false);

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

  const providers = (query.data?.providers ?? []).filter((p) => p.enabled);
  const roles = query.data?.roles ?? [];

  const update = (role: string, next: ChainLink[]) => {
    setSaved(false);
    setChains((c) => ({ ...c, [role]: next }));
  };

  function body(): Record<string, unknown> {
    return {
      local_only: localOnly,
      roles: Object.fromEntries(
        Object.entries(chains)
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
      <div data-testid="llm-routing" className="flex flex-col gap-3">
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
              setSaved(false);
              setLocalOnly(e.target.checked);
            }}
            className="mt-0.5"
          />
          <span>
            <strong>Local only.</strong> Refuse any role that would send code outside my network
            (including Tier-3, the Claude API). Roles without a chain use only my local connections.
          </span>
        </label>

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
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="text-fg-muted">{i + 1}.</span>
                            <span>{link.provider_name ?? `connection ${link.provider_id}`}</span>
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
                      {effectiveChainText(chain, providers, localOnly)}
                    </p>
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="routing-save"
            disabled={save.isPending}
            onClick={() => {
              setSaved(false);
              save.mutate(body(), { onSuccess: () => setSaved(true) });
            }}
            className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save routing'}
          </button>
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
