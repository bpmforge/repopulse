import { Link } from '@tanstack/react-router';
import type { RepoSecurity } from './contracts.js';
import { FindingSeverityBadge } from '../findings/FindingSeverity.js';

// Attack chains (W8-10, SECURITY_SUITE.md §5).
//
// A chain is rendered entry → … → impact, and every node links to the finding
// it is made of: the value of a chain is that it turns three medium findings
// into one path someone can walk, and a path you cannot click through is a
// picture of an argument rather than the argument.

interface Props {
  chains: RepoSecurity['chains'];
  computed: boolean;
  /** The repository, so links keep the drill-down scoped to it. */
  repoId?: string;
}

/**
 * A chain's name: where it starts and what it reaches (W20-13, UX_TODO
 * FND-46). The internal id told a reader nothing.
 */
export function chainName(chain: RepoSecurity['chains'][number]): string {
  const first = chain.nodes[0]?.title;
  const last = chain.nodes[chain.nodes.length - 1]?.title;
  if (!first) return 'Attack chain';
  return last && last !== first ? `${first} → ${last}` : first;
}

/** Reviews, filtered to one chain's findings in every status (FND-46). */
function chainSearch(chainId: string, repoId: string | undefined): Record<string, string> {
  return { chain_id: chainId, status: 'any', ...(repoId ? { repos: repoId } : {}) };
}

export function ChainsPanel({ chains, computed, repoId }: Props) {
  if (chains.length === 0) {
    return (
      <p className="text-sm text-fg-muted" data-testid="chains-empty">
        {computed
          ? 'No attack chains: no finding yields anything another finding needs.'
          : // The distinction that matters. "No chains" and "nobody has looked
            // for chains" are different sentences, and only one of them is
            // reassuring.
            'Chain analysis has not run for this repository yet, so no chains have been looked for.'}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-3" data-testid="chains">
      {chains.map((chain) => (
        <li key={chain.id} className="rounded-md border border-border p-2" data-testid="chain">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span className="font-medium text-fg" data-testid="chain-name">
              {chainName(chain)}
            </span>
            <FindingSeverityBadge severity={chain.severity} />
            <span>(its worst step)</span>
            <Link
              to="/findings"
              search={chainSearch(chain.id, repoId) as never}
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`chain-findings-${chain.id}`}
            >
              Show these findings
            </Link>
          </div>
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {chain.nodes.map((node, index) => (
              <li key={node.finding_id} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden="true">→</span>}
                <Link
                  to="/findings"
                  search={
                    { finding: node.finding_id, ...(repoId ? { repos: repoId } : {}) } as never
                  }
                  className="rounded-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`chain-node-${node.finding_id}`}
                >
                  {node.title}
                </Link>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}
