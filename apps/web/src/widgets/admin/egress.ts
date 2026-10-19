// What leaves the network, said plainly, per role (W19-07).
//
// The sentence is built from what the SERVER reports for each connection (its
// host, and whether that host is on the operator's network by the same
// definition the egress audit uses), never from the connection's name or from
// what the form said. A hosted vendor named "Local" still reads as leaving.

export interface EgressLink {
  provider_id: number;
  provider_name: string | null;
  host: string | null;
  leaves_network: boolean | null;
}

export interface EgressProvider {
  id: number;
  name: string;
  enabled: boolean;
  host: string | null;
  leaves_network: boolean | null;
}

/**
 * `gateway` (W20-06, UX_TODO AI-06): the endpoint is on the network, but it is a
 * gateway that may forward what it receives to a vendor. The host alone cannot
 * tell, so it is never called "stays home".
 */
export type EgressTone = 'stays' | 'gateway' | 'leaves' | 'unavailable';

export interface EgressSummary {
  tone: EgressTone;
  /** One or two sentences, ready to print. */
  text: string;
}

/** What is actually sent. One definition, repeated on the screen so nobody guesses. */
export const WHAT_IS_SENT = 'diffs, pull-request descriptions and file paths';

const leaves = (x: { leaves_network: boolean | null }): boolean => x.leaves_network !== false;
const where = (x: { host: string | null }): string => x.host ?? 'an endpoint we could not read';

const linkName = (l: EgressLink): string => l.provider_name ?? `connection ${l.provider_id}`;

/** The sentence for a role whose code stays on the network, unless a gateway forwards it. */
function staysOrGateway(
  text: string,
  ids: readonly number[],
  gateways: ReadonlySet<number>,
  names: string[],
): EgressSummary {
  if (!ids.some((id) => gateways.has(id))) return { tone: 'stays', text };
  return {
    tone: 'gateway',
    text: `${text.replace(/^Stays on your network\. /, 'Sent to a gateway on your network. ')} ${names.join(', ')} ${names.length === 1 ? 'is a gateway' : 'are gateways'}: your code stays on your network only if the gateway does not forward it to a vendor.`,
  };
}

export function summarizeRole(args: {
  chain: readonly EgressLink[];
  providers: readonly EgressProvider[];
  localOnly: boolean;
  /**
   * Connections known to be gateways (W20-06, UX_TODO AI-06), such as one just
   * added through the wizard's "Through a gateway I run". The server cannot tell
   * a LiteLLM proxy on a LAN IP from a model on one, so this comes from the person.
   */
  gatewayIds?: ReadonlySet<number>;
}): EgressSummary {
  const { chain, providers, localOnly } = args;
  const gateways = args.gatewayIds ?? new Set<number>();

  if (chain.length === 0) {
    // No chain: the shared pool. Under local-only only local connections are used.
    const pool = providers.filter((p) => p.enabled && (!localOnly || !leaves(p)));
    if (pool.length === 0) {
      return {
        tone: 'unavailable',
        text: localOnly
          ? 'No connection on your network is available for this role, so it will skip and say so.'
          : 'No connection is set up for this role, so it will skip and say so.',
      };
    }
    const away = pool.filter(leaves);
    if (away.length === 0) {
      return staysOrGateway(
        `Stays on your network. Uses ${pool.map((p) => p.name).join(', ')}.`,
        pool.map((p) => p.id),
        gateways,
        pool.filter((p) => gateways.has(p.id)).map((p) => p.name),
      );
    }
    return {
      tone: 'leaves',
      text: `May leave your network: the shared pool includes ${away
        .map((p) => `${p.name} (${where(p)})`)
        .join(
          ', ',
        )}, which receives ${WHAT_IS_SENT}. Each request is recorded in the egress audit.`,
    };
  }

  const first = chain[0]!;
  const name = linkName(first);

  // W20-06 (UX_TODO AI-58): under Local only an off-network link is BLOCKED, not
  // used - the gateway refuses the role when it reaches one. Saying "Leaves your
  // network" under a "Local only is on" heading contradicted itself.
  if (localOnly && chain.some(leaves)) {
    if (leaves(first)) {
      return {
        tone: 'unavailable',
        text: `Blocked by Local only: ${name} (${where(first)}) is outside your network, so this role refuses and says so. Nothing is sent. Put a connection on your network first, or turn Local only off.`,
      };
    }
    const home = chain.slice(0, chain.findIndex(leaves));
    const blocked = chain.filter(leaves);
    const base = staysOrGateway(
      `Stays on your network. Uses ${home.map(linkName).join(', then ')}.`,
      home.map((l) => l.provider_id),
      gateways,
      home.filter((l) => gateways.has(l.provider_id)).map(linkName),
    );
    return {
      ...base,
      text: `${base.text} Local only blocks ${blocked.map((l) => `${linkName(l)} (${where(l)})`).join(', ')}, so if ${home.length === 1 ? 'it is' : 'they are'} down the role refuses instead of falling back.`,
    };
  }

  const fallbacks = chain.slice(1);
  const fallbackNote =
    fallbacks.length === 0
      ? ''
      : ` If it is down or refuses, ${fallbacks
          .map(
            (l) =>
              `${l.provider_name ?? `connection ${l.provider_id}`} (${leaves(l) ? `leaves your network, ${where(l)}` : 'stays on your network'})`,
          )
          .join(', then ')} is tried.`;

  if (!leaves(first) && fallbacks.every((l) => !leaves(l))) {
    return staysOrGateway(
      `Stays on your network. Uses ${name}.${fallbackNote}`,
      chain.map((l) => l.provider_id),
      gateways,
      chain.filter((l) => gateways.has(l.provider_id)).map(linkName),
    );
  }
  if (!leaves(first)) {
    return {
      tone: 'leaves',
      text: `Normally stays on your network (${name}), but the fallback can send it away.${fallbackNote} It then receives ${WHAT_IS_SENT}, recorded in the egress audit.`,
    };
  }
  return {
    tone: 'leaves',
    text: `Leaves your network. ${name} (${where(first)}) receives ${WHAT_IS_SENT}. Each request is recorded in the egress audit.${fallbackNote}`,
  };
}

/**
 * The line that belongs under the table, once. Tier-3 is a different switch.
 *
 * W20-06 (UX_TODO AI-72): it used to describe Tier-3 as if it ran. No Tier-3
 * transport is wired, so a repository opt-in sends nothing today, while hosted
 * connections added here are used for every repository. Said plainly.
 */
export const TIER3_NOTE =
  'Connections set up here are used for every repository, hosted ones included. Tier 3 (the Claude API, per-repository opt-in) is not available yet: opting a repository in sends nothing today.';
