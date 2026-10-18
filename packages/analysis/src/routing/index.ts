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
//      leaving the network (isLocalHost): loopback, RFC1918, *.local,
//      *.internal. One definition, so a call is audited exactly when
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
] as const;

export type LlmRole = (typeof LLM_ROLES)[number];

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

export class LocalOnlyViolationError extends Error {
  constructor(
    readonly role: LlmRole | null,
    readonly providerName: string,
  ) {
    super(
      role
        ? `Local-only is on: role "${role}" would send to connection "${providerName}", which is outside your network.`
        : `Local-only is on: connection "${providerName}" is outside your network.`,
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
        out.push(new LocalOnlyViolationError(role, link.providerName).message);
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
