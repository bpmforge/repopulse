import { asc, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import {
  LLM_ROLES,
  PROVIDER_REGISTRY,
  localOnlyViolations,
  type LlmProviderKind,
  isLocalHost,
  type LlmRole,
  type RoutingChains,
  type RoutingPolicy,
  type T2Host,
} from '@repopulse/analysis';

// Loading and checking a workspace's role routing (W19-02). Shared by the admin
// route and the worker gateway, so "what the admin saved" and "what a pass
// runs" are read by one function.

export interface StoredRoute {
  role: LlmRole;
  providerId: number;
  model: string | null;
}

export interface StoredRouting {
  localOnly: boolean;
  routes: StoredRoute[];
}

/** Always workspace-filtered (Law 5). */
export async function loadStoredRouting(db: Database, workspaceId: number): Promise<StoredRouting> {
  const [policy] = await db
    .select({ localOnly: core.llmRoutingPolicy.localOnly })
    .from(core.llmRoutingPolicy)
    .where(eq(core.llmRoutingPolicy.workspaceId, workspaceId))
    .limit(1);
  const rows = await db
    .select({
      role: core.llmRoleRoutes.role,
      providerId: core.llmRoleRoutes.providerId,
      model: core.llmRoleRoutes.model,
    })
    .from(core.llmRoleRoutes)
    .where(eq(core.llmRoleRoutes.workspaceId, workspaceId))
    .orderBy(asc(core.llmRoleRoutes.role), asc(core.llmRoleRoutes.position));
  return {
    localOnly: policy?.localOnly ?? false,
    routes: rows.map((r) => ({
      role: r.role as LlmRole,
      providerId: r.providerId,
      model: r.model,
    })),
  };
}

/**
 * Chains over HOSTS that actually resolved. A role that is routed but none of
 * whose connections resolved gets an EMPTY chain — which the gateway refuses
 * with a sentence — rather than no chain, which would silently send the role
 * to the shared pool and a model the admin did not choose.
 */
export function chainsFor(stored: StoredRouting, hosts: T2Host[]): RoutingChains {
  const byId = new Map(hosts.map((h) => [h.providerId, h]));
  const chains: RoutingChains = {};
  for (const role of LLM_ROLES) {
    const links = stored.routes.filter((r) => r.role === role);
    if (links.length === 0) continue;
    chains[role] = links.flatMap((r) => {
      const host = byId.get(r.providerId);
      if (!host) return [];
      const withModel = r.model ? { ...host, modelSlot: r.model } : host;
      return [{ host: withModel, providerName: host.name ?? host.baseUrl }];
    });
  }
  return chains;
}

/** The base URL a provider will actually use — its own, or its kind's fixed endpoint. */
export function effectiveBaseUrl(kind: string, baseUrl: string | null): string | null {
  return baseUrl ?? PROVIDER_REGISTRY[kind as LlmProviderKind]?.defaultBaseUrl ?? null;
}

export interface ProviderForCheck {
  id: number;
  name: string;
  kind: string;
  baseUrl: string | null;
  model: string;
}

/** Local-only violations for a proposed configuration, from stored provider rows. */
export function violationsFor(
  localOnly: boolean,
  routes: StoredRoute[],
  providers: ProviderForCheck[],
): string[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const policy: RoutingPolicy = { localOnly, chains: {} };
  for (const role of LLM_ROLES) {
    const links = routes.filter((r) => r.role === role);
    if (links.length === 0) continue;
    policy.chains[role] = links.flatMap((r) => {
      const p = byId.get(r.providerId);
      const base = p ? effectiveBaseUrl(p.kind, p.baseUrl) : null;
      if (!p || !base) return [];
      return [
        {
          host: { baseUrl: base, modelSlot: r.model ?? p.model, name: p.name },
          providerName: p.name,
        },
      ];
    });
  }
  return localOnlyViolations(policy);
}

export async function providersFor(db: Database, workspaceId: number) {
  return db
    .select({
      id: core.llmProviders.id,
      name: core.llmProviders.name,
      kind: core.llmProviders.kind,
      baseUrl: core.llmProviders.baseUrl,
      model: core.llmProviders.model,
      enabled: core.llmProviders.enabled,
    })
    .from(core.llmProviders)
    .where(eq(core.llmProviders.workspaceId, workspaceId))
    .orderBy(asc(core.llmProviders.name));
}

/**
 * Where a connection sends requests, for the screen to state plainly (W19-07).
 * `host` is the endpoint's host only - never a path, a key or a header - and
 * `leavesNetwork` uses the SAME definition as the egress audit and local-only
 * (isLocalHost), so what the screen says leaves is exactly what is audited.
 */
export function describeEndpoint(
  kind: string,
  baseUrl: string | null,
): { host: string | null; leavesNetwork: boolean; hostIsName: boolean } {
  const base = effectiveBaseUrl(kind, baseUrl);
  if (!base) return { host: null, leavesNetwork: true, hostIsName: false };
  try {
    const host = new URL(base).host;
    const bare = host.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
    // A name is anything that is not an IP literal; `localhost` is loopback by
    // the host policy and is not treated as a name here.
    const hostIsName =
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) && !bare.includes(':') && bare !== 'localhost';
    return { host, leavesNetwork: !isLocalHost(host), hostIsName };
  } catch {
    // An endpoint we cannot read is not one we can promise stays home.
    return { host: null, leavesNetwork: true, hostIsName: false };
  }
}
