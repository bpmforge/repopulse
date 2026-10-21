import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, registerWidget } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { OrgSecurity } from './contracts.js';
import { reposParam, withRepos } from '../scopeRepos.js';

// Org security rollup (W8-10, SECURITY_SUITE.md §5, FR-INSIGHTS-2).
//
// One tile, three claims, each of which has to be defensible: how much is open
// and how bad, whether anything is known-exploited, and whether any credential
// has been confirmed live. The BASIS line under them is what keeps the tile
// honest — with one scanner running, "0 open" means "one scanner found
// nothing", and a reader who cannot see that will read it as an audit.

const SEVERITY_NAME: Record<number, string> = {
  5: 'critical',
  4: 'high',
  3: 'medium',
  2: 'low',
  1: 'info',
};

export function SecurityRollupTile({ repos }: { repos?: string | undefined } = {}) {
  // A view's repositories (W20-09, UX_TODO DSH-02); absent = the workspace.
  const { data, isLoading, isError, error, refetch } = useApiQuery<OrgSecurity>({
    endpoint: '/org/security',
    query: withRepos({}, repos),
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
          {/* W20-20 (UX_TODO DSH-76): before any scan has finished, zeros in
              every severity read as a clean audit. Say so instead. */}
          {data.scanned === false ? (
            <p className="text-fg-muted" data-testid="rollup-not-scanned">
              Not scanned yet: no security scan has finished for these repositories.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {[5, 4, 3, 2, 1].map((severity) => {
                const fresh = data.new_by_severity?.[String(severity)] ?? 0;
                return (
                  <div key={severity} className="flex flex-col" data-testid={`sev-${severity}`}>
                    {/* Named, not "sev 5" (W18-28): every other surface uses the
                      severity words, and a bare number does not say which end
                      is bad. */}
                    <span className="text-xs text-fg-muted">{SEVERITY_NAME[severity]}</span>
                    {/* W20-21 (UX_TODO FND-55): each count opens the findings
                      behind it, and says what is new since yesterday. */}
                    <Link
                      to="/findings"
                      search={
                        withRepos(
                          { dimension_group: 'security', severity: String(severity) },
                          repos,
                        ) as never
                      }
                      className="tabular-nums underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      data-testid={`sev-link-${severity}`}
                    >
                      {bySeverity[String(severity)] ?? 0}
                    </Link>
                    {fresh > 0 && (
                      <span className="text-xs text-fg-muted" data-testid={`sev-new-${severity}`}>
                        +{fresh} since yesterday
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {(data.experimental_open ?? 0) > 0 && (
            <p className="text-xs text-fg-muted" data-testid="rollup-trial">
              +{data.experimental_open} from rules in trial, not counted above.
            </p>
          )}

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
                : data.live_checks === false
                  ? // W20-20 (DSH-76): nothing checks liveness, so "no credential
                    // confirmed live" claimed a check that never ran.
                    'live credential checks are off'
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
            {data.scanners_run && data.scanners_run.length > 0
              ? `Basis: ${data.scanners_run
                  .map((r) => `${r.key} (last run ${r.last_finished_at.slice(0, 10)})`)
                  .join(', ')}`
              : `Basis: ${data.basis}`}
          </p>

          <Link
            to="/findings"
            // W20-21 (FND-55): every security scanner's findings, not only secrets.
            search={withRepos({ dimension_group: 'security' }, repos) as never}
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
  component: ({ widget }) => (
    <SecurityRollupTile
      repos={reposParam(widget.options?.search as Record<string, string> | undefined)}
    />
  ),
});
