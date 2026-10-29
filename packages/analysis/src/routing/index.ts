import { isLocalHost } from '../gateway/egress-auditor.js';
import type { T2Host } from '../t2/client.js';

// Per-role model routing (W19-02).
//
// A workspace maps each ROLE to an ordered chain of (provider connection,
// model). The role names are the ones in docs/design/ATTEST_EXPERTS.md so the
// specialist roster (W19-03) plugs in without renames.
//
// THREE RULES, each of which has a test:
//
//   1. FALL BACK ON PROVIDER ERRORS ONLY. A refused connection, a 5xx, a 429 or
//      a bad key moves to the next link. A model that answered badly (empty,
//      reasoning-exhausted, unparseable) does NOT — trying a different model
//      until one produces the answer you wanted is how a quality problem
//      becomes an untraceable one.
//   2. LOCAL-ONLY IS ENFORCED TWICE. When the workspace is configured, the
//      admin API refuses a chain that would leave the network and names the
//      role and the connection. At call time the gateway refuses again — a
//      connection can be edited after the chain was saved.
//   3. "LEAVES THE CONTAINER" means what the egress audit already means by
//      leaving the network (isLocalHost): anything but loopback and private
//      IPv4. A host name, even *.local or *.internal, leaves. One definition
//      (config/hosts.ts, shared with the host policy), so a call is audited exactly when
//      local-only would have refused it.

export const LLM_ROLES = [
  'security',
  'performance',
  'code_health',
  'best_practices',
  'ai_slop',
  'test_coverage',
  'triage',
  'patch',
  // W22-03 (2026-10-29): optional. A smaller, faster model the AI judge asks
  // first; with no chain it is not called at all (never the shared pool).
  'triage_fast',
] as const;

export type LlmRole = (typeof LLM_ROLES)[number];

/**
 * W22-03 (2026-10-29): roles that are called only when a workspace routes
 * them. With no chain they are skipped by their caller and never fall to the
 * shared pool (the gateway refuses), and an egress summary leaves them out.
 */
export const OPTIONAL_LLM_ROLES: readonly LlmRole[] = ['triage_fast'];

export function isOptionalRole(role: LlmRole | null | undefined): boolean {
  return role !== null && role !== undefined && OPTIONAL_LLM_ROLES.includes(role);
}

/** Is this optional role routed in the policy (a chain exists, even an empty one)? */
export function isRoleRouted(policy: RoutingPolicy | undefined, role: LlmRole): boolean {
  return policy?.chains[role] !== undefined;
}

export function isLlmRole(v: unknown): v is LlmRole {
  return typeof v === 'string' && (LLM_ROLES as readonly string[]).includes(v);
}

/** The analysis `dimension` a pass declares, as the role that serves it. */
export function roleForDimension(dimension: string): LlmRole | null {
  switch (dimension) {
    case 'security':
    case 'performance':
    case 'code_health':
    case 'test_coverage':
    case 'best_practices':
    case 'ai_slop':
      return dimension;
    default:
      return null;
  }
}

/** One link of a chain: a resolved host plus the names a sentence needs. */
export interface RouteLink {
  host: T2Host;
  /** The connection's label — what an admin recognises. */
  providerName: string;
}

/** role -> ordered links. A role with no entry uses the workspace's default pool. */
export type RoutingChains = Partial<Record<LlmRole, RouteLink[]>>;

export interface RoutingPolicy {
  chains: RoutingChains;
  /** Refuse anything that would leave the operator's network. */
  localOnly: boolean;
}

/** Which link served a call, and which links failed first. Recorded, not guessed. */
export interface RouteRecord {
  role: LlmRole | null;
  providerId: number | null;
  providerName: string;
  model: string;
  /** 0 is the first choice; anything above means the earlier links failed. */
  linkIndex: number;
  failedLinks: { providerName: string; model: string; error: string }[];
}

export function hostIsLocal(host: T2Host): boolean {
  try {
    return isLocalHost(new URL(host.chatUrl ?? host.baseUrl).host);
  } catch {
    return false;
  }
}

/**
 * Names that used to count as "on your network" (the audit trusted `.local` and
 * `.internal`) and no longer do. A refusal about one of these says so, because
 * "outside your network" about a host that sits in a rack next to the admin is
 * confusing without the reason.
 */
const FORMERLY_TRUSTED_NAME = /\.(local|internal)(:\d+)?$/i;

export class LocalOnlyViolationError extends Error {
  constructor(
    readonly role: LlmRole | null,
    readonly providerName: string,
    host?: string | null,
  ) {
    const hint =
      host && FORMERLY_TRUSTED_NAME.test(host)
        ? ` It is reached by the host name ${host}, and only IP addresses count as on your network - use the machine's IP address.`
        : '';
    super(
      (role
        ? `Local-only is on: role "${role}" would send to connection "${providerName}", which is outside your network.`
        : `Local-only is on: connection "${providerName}" is outside your network.`) + hint,
    );
    this.name = 'LocalOnlyViolationError';
  }
}

/**
 * The sentences that stop a routing configuration being saved. Empty means it
 * may be saved. Each names the role and the connection, as the ticket requires.
 */
export function localOnlyViolations(policy: RoutingPolicy): string[] {
  if (!policy.localOnly) return [];
  const out: string[] = [];
  for (const role of LLM_ROLES) {
    for (const link of policy.chains[role] ?? []) {
      if (!hostIsLocal(link.host)) {
        out.push(new LocalOnlyViolationError(role, link.providerName, hostOf(link.host)).message);
      }
    }
  }
  return out;
}

/**
 * Providers a role with NO chain may use. Under local-only the default pool
 * silently drops anything non-local rather than failing the role: the role was
 * never routed anywhere in particular, so there is nothing to name and refuse.
 */
export function defaultPool(hosts: T2Host[], localOnly: boolean): T2Host[] {
  return localOnly ? hosts.filter(hostIsLocal) : hosts;
}

/**
 * The smallest probed context window among the connections a role may use
 * (W19-03). The smallest, because a fallback link can serve any call and the
 * chunks must fit whichever one does. `null` when none has a known window — an
 * unknown window is not a small one, and callers keep the default budget.
 */
export function contextWindowForRole(
  policy: RoutingPolicy | undefined,
  role: LlmRole,
  pool: readonly T2Host[],
): number | null {
  const chain = policy?.chains[role];
  const hosts =
    chain !== undefined
      ? chain.map((l) => l.host)
      : defaultPool([...pool], policy?.localOnly ?? false);
  const known = hosts.map((h) => h.contextWindow).filter((n): n is number => typeof n === 'number');
  return known.length === 0 ? null : Math.min(...known);
}

/** The host (with port) a T2 host sends to, for messages. */
export function hostOf(host: T2Host): string | null {
  try {
    return new URL(host.chatUrl ?? host.baseUrl).host;
  } catch {
    return null;
  }
}
