import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { OrgSecurity } from './contracts.js';

// Org security rollup (W8-10, SECURITY_SUITE.md §5, FR-INSIGHTS-2).
//
// One tile, three claims, each of which has to be defensible: how much is open
// and how bad, whether anything is known-exploited, and whether any credential
// has been confirmed live. The BASIS line under them is what keeps the tile
// honest — with one scanner running, "0 open" means "one scanner found
// nothing", and a reader who cannot see that will read it as an audit.

export function SecurityRollupTile() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSecurity>({
    endpoint: '/org/security',
  });

  const state = frameState({ isLoading, isError, isEmpty: false });
  const bySeverity = data?.open_by_severity ?? {};

  return (
    <WidgetFrame
      title="Security"
      state={state}
      // W17-31: every failed frame offers Retry, like the rest of the overview.
      onRetry={() => void refetch()}
      {...(error ? { errorMessage: error.message, error } : {})}
      testId="security-rollup"
    >
      {data && (
        <div className="flex flex-col gap-2 text-sm" data-testid="security-rollup-body">
          <div className="flex flex-wrap gap-3">
            {[5, 4, 3, 2, 1].map((severity) => (
              <div key={severity} className="flex flex-col" data-testid={`sev-${severity}`}>
                <span className="text-xs text-fg-muted">sev {severity}</span>
                <span className="tabular-nums">{bySeverity[String(severity)] ?? 0}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-4">
            <span data-testid="rollup-kev">
              {/* Known-exploited is the one number that should never be a
                  neutral chip: it means someone is using it today. */}
              {data.kev_count > 0
                ? `! ${data.kev_count} known-exploited`
                : 'no known-exploited CVEs'}
            </span>
            <span data-testid="rollup-verified">
              {data.verified_secrets > 0
                ? `! ${data.verified_secrets} verified live credentials`
                : 'no credential confirmed live'}
            </span>
            <span data-testid="rollup-chain">
              {data.worst_chain
                ? `worst chain: severity ${data.worst_chain.severity}`
                : 'no attack chain computed'}
            </span>
          </div>

          {/* The basis label, same discipline as the health score's "Tier-1
              only": what these numbers are actually built on. */}
          <p className="text-xs text-fg-muted" data-testid="rollup-basis">
            Basis: {data.basis}
          </p>

          <Link
            to="/findings"
            search={{ dimension: 'secrets' } as never}
            className="text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="rollup-drill"
          >
            Open security findings
          </Link>
        </div>
      )}
    </WidgetFrame>
  );
}

registerWidget({
  type: 'security-rollup',
  title: 'Security',
  category: 'lists',
  // Its own type, never a reused one: registerWidget overwrites by type, and
  // that silent replacement already cost a panel once (W5-07).
  defaultSize: { w: 4, h: 2 },
  component: () => <SecurityRollupTile />,
});
