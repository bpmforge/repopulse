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

export type EgressTone = 'stays' | 'leaves' | 'unavailable';

export interface EgressSummary {
  tone: EgressTone;
  /** One or two sentences, ready to print. */
  text: string;
}

/** What is actually sent. One definition, repeated on the screen so nobody guesses. */
export const WHAT_IS_SENT = 'diffs, pull-request descriptions and file paths';

const leaves = (x: { leaves_network: boolean | null }): boolean => x.leaves_network !== false;
const where = (x: { host: string | null }): string => x.host ?? 'an endpoint we could not read';

export function summarizeRole(args: {
  chain: readonly EgressLink[];
  providers: readonly EgressProvider[];
  localOnly: boolean;
}): EgressSummary {
  const { chain, providers, localOnly } = args;

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
      return {
        tone: 'stays',
        text: `Stays on your network. Uses ${pool.map((p) => p.name).join(', ')}.`,
      };
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
  const name = first.provider_name ?? `connection ${first.provider_id}`;
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
    return { tone: 'stays', text: `Stays on your network. Uses ${name}.${fallbackNote}` };
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

/** The line that belongs under the table, once. Tier-3 is a different switch. */
export const TIER3_NOTE =
  'Separately, Tier-3 (the Claude API) is off unless a repository opts in, and every Tier-3 call leaves your network and is audited. "Local only" blocks it entirely.';
