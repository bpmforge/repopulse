import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { ScannerStatusList } from '../../../widgets/security/ScannerStatusList.js';
import { RunScanButton } from '../../../widgets/security/RunScanButton.js';
import { ChainsPanel } from '../../../widgets/security/ChainsPanel.js';
// W8-14. OUT OF THAT TICKET'S DECLARED WRITE SCOPE and mounted anyway: a
// funnel widget nobody renders is a widget that does not exist, and FR-SEC-15
// is about what the Security tab SHOWS. Declared in the handoff.
import { ValidationFunnelPanel } from '../../../widgets/security/ValidationFunnelPanel.js';
import type { RepoSecurity } from '../../../widgets/security/contracts.js';

// Repo Security tab (W8-10, SECURITY_SUITE.md §5, FR-SEC-10 / NFR-15).
//
// Every panel here can be empty, and each empty state has to say WHY: a scanner
// that is off, one that has never run, and one that ran clean look identical if
// all you print is a count. That is the failure mode this whole screen is
// designed against — a security page that says nothing and reads as "safe".

export const Route = createFileRoute('/repos/$repoId/security')({ component: SecurityTab });

function SecurityTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/security' });
  const { data, isLoading, isError, error } = useApiQuery<RepoSecurity>({
    endpoint: '/repos/{id}/security',
    path: { id: repoId },
  });

  const state = frameState({
    isLoading,
    isError,
    isEmpty: false, // never "empty": the scanner table is the content
  });

  return (
    <div className="flex flex-col gap-4" data-testid="security-tab">
      <WidgetFrame
        title="Coverage"
        state={state}
        {...(error ? { errorMessage: error.message } : {})}
        testId="security-coverage"
      >
        {data && <ScannerStatusList scanners={data.scanners} />}
        {/* W16-10 (F15). This table said "never run" for every scanner and
            offered no way to change that. */}
        <div className="mt-3">
          <RunScanButton
            repoId={repoId}
            invalidate={[queryKeyFor({ endpoint: '/repos/{id}/security', path: { id: repoId } })]}
          />
        </div>
      </WidgetFrame>

      <div className="grid gap-4 md:grid-cols-2">
        <WidgetFrame title="Secrets" state={state} testId="security-secrets">
          {data && (
            <dl className="flex flex-col gap-1 text-sm" data-testid="secrets-summary">
              <div className="flex justify-between">
                <dt>Open secret findings</dt>
                <dd className="tabular-nums" data-testid="secrets-open">
                  {data.secrets.open}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Verified live credentials</dt>
                {/* Always called out, and honestly zero while live
                    verification is off (W8-04): nothing can confirm liveness
                    yet, so this is "none confirmed", not "none exist". */}
                <dd className="tabular-nums" data-testid="secrets-verified">
                  {data.secrets.verified === 0 ? 'none confirmed' : data.secrets.verified}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Last scan of new commits</dt>
                <dd data-testid="secrets-last-stream">
                  {data.secrets.last_stream_scan_at
                    ? new Date(data.secrets.last_stream_scan_at).toLocaleDateString()
                    : 'never'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Last sweep of history</dt>
                {/* Two clocks on purpose: a repo scanned on every push but
                    never swept has 12 months nobody has read. */}
                <dd data-testid="secrets-last-history">
                  {data.secrets.last_history_scan_at
                    ? new Date(data.secrets.last_history_scan_at).toLocaleDateString()
                    : 'never'}
                </dd>
              </div>
            </dl>
          )}
          {data && (
            // Outside the <dl>: a definition list may only contain dt/dd
            // groups, and an <a> inside one is an axe violation — caught by
            // the a11y sweep on this very route.
            <Link
              to="/findings"
              search={{ dimension: 'secrets' } as never}
              className="mt-2 inline-block text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="secrets-drill"
            >
              Open in Findings
            </Link>
          )}
        </WidgetFrame>

        <WidgetFrame title="Vulnerable dependencies" state={state} testId="security-cves">
          {data &&
            (data.cves.length === 0 ? (
              <p className="text-sm text-fg-muted" data-testid="cves-empty">
                {/* Named cause, not a shrug: the dependency scanner needs tools
                    that are not installed here (W8-06), and a bare "no CVEs"
                    would be a claim nobody has earned. */}
                No dependency scan has run for this repository — the CVE scanner is not available
                yet, so this is not a clean bill of health.
              </p>
            ) : (
              <table className="w-full text-sm" data-testid="cve-table">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th scope="col">CVE</th>
                    <th scope="col">Package</th>
                    <th scope="col">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cves.map((cve) => (
                    <tr key={cve.cve_id} className="border-t border-border">
                      <th scope="row" className="text-left font-normal">
                        {cve.cve_id}
                        {cve.kev && (
                          <span className="ml-1 text-xs" data-testid="kev-flag">
                            ! known exploited
                          </span>
                        )}
                      </th>
                      <td>{cve.package}</td>
                      <td className="tabular-nums">{cve.severity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
        </WidgetFrame>
      </div>

      <WidgetFrame
        title="Dependency findings, raw to triaged"
        state={state}
        testId="security-funnel"
      >
        {data && (
          <ValidationFunnelPanel
            funnel={data.validation_funnel}
            recorded={data.validation_funnel_recorded}
            vex={data.vex}
            // The scanner rows go in whole. The panel derives the open count
            // from them, so the arithmetic it reconciles is the arithmetic its
            // own tests exercise — a number computed here would be untested in
            // the one place it can be wrong.
            scanners={data.scanners}
          />
        )}
      </WidgetFrame>

      <WidgetFrame title="Attack chains" state={state} testId="security-chains">
        {data && <ChainsPanel chains={data.chains} computed={data.chains_computed} />}
      </WidgetFrame>
    </div>
  );
}
