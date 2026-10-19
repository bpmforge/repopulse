import { createHash } from 'node:crypto';
import type { Database } from '@repopulse/shared';
import type { LlmRole } from '@repopulse/analysis';
import { describeEndpoint, loadStoredRouting, providersFor } from './llm-routing.js';

// Where a scheduled AI pass would send source code, said from the SERVER's own
// facts (W19-12). Built from the stored routing and each connection's endpoint
// host, with "leaves the network" decided by the SAME definition as the egress
// audit and local-only (describeEndpoint -> isLocalHost). Never from a
// connection's name.
//
// The digest is what an admin acknowledges when they enable a schedule. If the
// routing later changes (a new connection, a role moved to a hosted link) the
// digest no longer matches and the schedule refuses to run - recorded, with the
// reason - until an admin acknowledges the new destinations.

/** The roles an AI pass calls: the specialists and triage. Patch drafting is its own flow. */
export const PASS_ROLES: readonly LlmRole[] = [
  'security',
  'performance',
  'code_health',
  'best_practices',
  'ai_slop',
  'test_coverage',
  'triage',
];

/** What is sent, in one place, so the screen and the audit say the same thing. */
export const PASS_SENDS =
  'the contents of the files in scope, or the diff of a pull request, with their paths';

export interface EgressDestination {
  provider_id: number;
  provider_name: string;
  host: string | null;
  leaves_network: boolean;
  roles: string[];
  /**
   * The models this connection would be asked for (W20-06, UX_TODO AI-11/AI-12):
   * a chain link's override, or the connection's own. Not part of the digest, so
   * adding it did not invalidate an acknowledged schedule.
   */
  models?: string[];
}

export interface PassEgress {
  local_only: boolean;
  destinations: EgressDestination[];
  /** True when ANY destination is off the operator's network. */
  leaves_network: boolean;
  digest: string;
  /** One or two sentences, ready to print. */
  sentence: string;
}

export function digestOf(localOnly: boolean, destinations: readonly EgressDestination[]): string {
  const canonical = JSON.stringify([
    localOnly,
    [...destinations]
      .sort((a, b) => a.provider_id - b.provider_id)
      .map((d) => [d.provider_id, d.host, d.leaves_network, [...d.roles].sort()]),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function sentenceFor(
  localOnly: boolean,
  destinations: readonly EgressDestination[],
): string {
  if (destinations.length === 0) {
    return localOnly
      ? 'No connection on your network is configured for these roles, so a scheduled pass could not run.'
      : 'No model connection is configured for these roles, so a scheduled pass could not run.';
  }
  const away = destinations.filter((d) => d.leaves_network);
  if (away.length === 0) {
    return `Stays on your network. Source is sent only to ${destinations.map((d) => `${d.provider_name} (${d.host ?? 'unknown host'})`).join(', ')}.`;
  }
  return `Leaves your network: ${away
    .map((d) => `${d.provider_name} (${d.host ?? 'an endpoint we could not read'})`)
    .join(', ')} would receive ${PASS_SENDS}. Each request is recorded in the egress audit.`;
}

/**
 * Always workspace-filtered (Law 5). `roles` defaults to an AI pass's; the
 * verified-fix flow asks for `['patch']` (W20-06, UX_TODO AI-12) so the drawer
 * can say which connection drafts the fix and whether the file leaves.
 */
export async function passEgress(
  db: Database,
  workspaceId: number,
  roles: readonly LlmRole[] = PASS_ROLES,
): Promise<PassEgress> {
  const stored = await loadStoredRouting(db, workspaceId);
  const providers = (await providersFor(db, workspaceId)).filter((p) => p.enabled);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const dest = new Map<number, EgressDestination>();
  const add = (providerId: number, role: string, model: string | null = null) => {
    const p = byId.get(providerId);
    if (!p) return;
    const where = describeEndpoint(p.kind, p.baseUrl);
    const d = dest.get(p.id) ?? {
      provider_id: p.id,
      provider_name: p.name,
      host: where.host,
      leaves_network: where.leavesNetwork,
      roles: [],
      models: [],
    };
    if (!d.roles.includes(role)) d.roles.push(role);
    const m = model ?? p.model;
    d.models ??= [];
    if (!d.models.includes(m)) d.models.push(m);
    dest.set(p.id, d);
  };
  for (const role of roles) {
    const chain = stored.routes.filter((r) => r.role === role);
    if (chain.length > 0) {
      for (const link of chain) add(link.providerId, role, link.model);
    } else {
      // No chain: the shared pool. Under local-only only local connections serve it.
      for (const p of providers) {
        if (stored.localOnly && describeEndpoint(p.kind, p.baseUrl).leavesNetwork) continue;
        add(p.id, role);
      }
    }
  }
  const destinations = [...dest.values()].sort((a, b) => a.provider_id - b.provider_id);
  return {
    local_only: stored.localOnly,
    destinations,
    leaves_network: destinations.some((d) => d.leaves_network),
    digest: digestOf(stored.localOnly, destinations),
    sentence: sentenceFor(stored.localOnly, destinations),
  };
}
