import { Link } from '@tanstack/react-router';
import type { RepoSecurity } from './contracts.js';

// Attack chains (W8-10, SECURITY_SUITE.md §5).
//
// A chain is rendered entry → … → impact, and every node links to the finding
// it is made of: the value of a chain is that it turns three medium findings
// into one path someone can walk, and a path you cannot click through is a
// picture of an argument rather than the argument.

interface Props {
  chains: RepoSecurity['chains'];
  computed: boolean;
}

export function ChainsPanel({ chains, computed }: Props) {
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
          <div className="mb-1 text-xs text-fg-muted">
            Chain {chain.id} · severity {chain.severity} (its worst step)
          </div>
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {chain.nodes.map((node, index) => (
              <li key={node.finding_id} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden="true">→</span>}
                <Link
                  to="/findings"
                  search={{ finding: node.finding_id } as never}
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
