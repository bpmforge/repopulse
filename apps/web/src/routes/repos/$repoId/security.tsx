import { createFileRoute, Link, redirect, useParams } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { API_BASE } from '../../../api/client.js';
import { ScannerStatusList, ScanToolingNote } from '../../../widgets/security/ScannerStatusList.js';
import { RunScanButton } from '../../../widgets/security/RunScanButton.js';
import { SarifImport } from '../../../widgets/security/SarifImport.js';
import { LicensesPanel } from '../../../widgets/security/LicensesPanel.js';
import { ChainsPanel } from '../../../widgets/security/ChainsPanel.js';
import { CoverageMap } from '../../../widgets/trust/CoverageMap.js';
// W8-14. OUT OF THAT TICKET'S DECLARED WRITE SCOPE and mounted anyway: a
// funnel widget nobody renders is a widget that does not exist, and FR-SEC-15
// is about what the Security tab SHOWS. Declared in the handoff.
import { ValidationFunnelPanel } from '../../../widgets/security/ValidationFunnelPanel.js';
import { useRef } from 'react';
import { useScanRun, type ScanRun } from '../../../widgets/security/useScanRun.js';
import { FindingSeverityBadge } from '../../../widgets/findings/FindingSeverity.js';
import {
  dependencyEmptyCopy,
  reachabilityWord,
  ranSuccessfully,
  type RepoSecurity,
} from '../../../widgets/security/contracts.js';

// Repo Security tab (W8-10, SECURITY_SUITE.md §5, FR-SEC-10 / NFR-15).
//
// Every panel here can be empty, and each empty state has to say WHY: a scanner
// that is off, one that has never run, and one that ran clean look identical if
// all you print is a count. That is the failure mode this whole screen is
// designed against — a security page that says nothing and reads as "safe".
//
// W17-20 closed the gaps that remained. The tab follows a manual scan to its
// end (useScanRun) instead of refetching once and hoping; the dependencies
// panel takes its empty sentence from the dependency scanner's own state
// instead of one fixed excuse; and the findings a scan DID leave are listed
// and linked, so a scan that found something is a screen with something on it.

/**
 * `?ai_path=` (W20-11, UX_TODO AI-44) used to land a finding's "start a pass on
 * this file" link here. The AI review pass has its own tab now (W24-04), so a
 * saved or shared link of the old shape is sent on to it, file and all.
 */
export function validateSecuritySearch(search: Record<string, unknown>): { ai_path?: string } {
  const raw = search.ai_path;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 500 ? { ai_path: raw } : {};
}

export const Route = createFileRoute('/repos/$repoId/security')({
  validateSearch: validateSecuritySearch,
  beforeLoad: ({ params, search, location }) => {
    if (search.ai_path || location.hash === 'ai-review-pass') {
      throw redirect({
        to: '/repos/$repoId/ai-review',
        params: { repoId: params.repoId },
        search: search.ai_path ? { ai_path: search.ai_path } : {},
        hash: 'ai-review-pass',
      } as never);
    }
  },
  component: SecurityTab,
});

function SecurityTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/security' });
  const descriptor = { endpoint: '/repos/{id}/security', path: { id: repoId } } as const;
  // The hook needs the latest payload to decide whether to keep polling, and
  // the query needs the hook's interval. A ref breaks the order: the query is
  // handed a function that reads whatever the hook decided this render.
  const intervalRef = useRef<ScanRun['refetchInterval']>(() => false);
  const { data, isLoading, isError, error } = useApiQuery<RepoSecurity>(descriptor, {
    refetchInterval: (latest) => intervalRef.current(latest),
    // W20-13 (UX_TODO FND-33): a scan started before switching tabs kept
    // reading "Scan running…" after it ended, because TanStack pauses polling
    // in a hidden tab. Safe to keep on: the interval stops once nothing is
    // pending.
    refetchIntervalInBackground: true,
  });
  const scan = useScanRun(data);
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
  intervalRef.current = scan.refetchInterval;

  const state = frameState({
    isLoading,
    isError,
    isEmpty: false, // never "empty": the scanner table is the content
  });

  const dependencyScanner = data?.scanners.find((s) => s.key === 'dependency_cve');
  const findings = data?.top_findings ?? [];
  const successfulRuns = (data?.scanners ?? []).filter(ranSuccessfully);
  const scannerName = (key: string) =>
    data?.scanners.find((s) => s.key === key)?.display_name ?? key;

  return (
    <div className="flex flex-col gap-4" data-testid="security-tab">
      <WidgetFrame
        title="Coverage"
        state={state}
        {...(error ? { error } : {})}
        testId="security-coverage"
      >
        {/* W20-08 (UX_TODO FND-07): admins switch scanners on and off here. */}
        {data && (
          <ScannerStatusList
            scanners={data.scanners}
            manage={isAdmin ? { repoId, invalidate: [queryKeyFor(descriptor)] } : null}
          />
        )}
        {data?.tooling && <ScanToolingNote tooling={data.tooling} />}
        {/* W16-10 (F15). This table said "never run" for every scanner and
            offered no way to change that. */}
        <div className="mt-3">
          <RunScanButton
            repoId={repoId}
            invalidate={[queryKeyFor(descriptor)]}
            running={scan.running}
            awaiting={scan.awaiting}
            stalled={scan.stalled}
            onStarted={scan.onStarted}
            {...(me?.role ? { canRun: isAdmin } : {})}
          />
        </div>
      </WidgetFrame>

      {/* W20-13 (UX_TODO FND-32): the findings themselves sit right under
          Coverage. Below the AI pass and the coverage map they were several
          screens down on a phone. */}
      <WidgetFrame title="Open findings" state={state} testId="security-findings">
        {data &&
          (findings.length === 0 ? (
            <p className="text-sm text-fg-muted" data-testid="security-findings-empty">
              {/* "No findings" is only good news after a run that could have
                  found some. The board's own words: no findings in a completed
                  scan requires a successful applicable run. */}
              {successfulRuns.length > 0
                ? `No open security findings. ${successfulRuns.map((s) => s.display_name).join(', ')} ` +
                  (successfulRuns.length === 1 ? 'has' : 'have') +
                  ' completed a run here; anything listed above as never run or failed has not looked, and this says nothing about it.'
                : 'No security findings are recorded, and no scanner has completed a run for this repository — so this is an absence of measurement, not a clean result.'}
            </p>
          ) : (
            <>
              <ol className="flex flex-col gap-1 text-sm" data-testid="security-findings-list">
                {findings.map((finding) => (
                  <li
                    key={finding.id}
                    className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-2"
                    data-testid={`security-finding-${finding.id}`}
                  >
                    <Link
                      // W20-20 (UX_TODO DSH-33): this repository's Findings
                      // tab, so the repo trail survives (it used to open the
                      // workspace list filtered to this repository).
                      to="/repos/$repoId/findings"
                      params={{ repoId }}
                      search={{ finding: finding.id } as never}
                      className="truncate underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      data-testid={`security-finding-link-${finding.id}`}
                    >
                      {finding.title}
                    </Link>
                    <span className="flex min-w-0 flex-wrap items-center gap-1 break-all text-xs text-fg-muted sm:shrink-0">
                      <FindingSeverityBadge severity={finding.severity} />
                      {finding.scanner_key ? ` · ${scannerName(finding.scanner_key)}` : ''}
                      {finding.file
                        ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ol>
              {/* W20-13 (UX_TODO FND-73): `open_total` counts every kind of
                  finding, this panel only the security ones. Both numbers are
                  said, each for what it is. */}
              {(data.security_open_total ?? findings.length) > findings.length && (
                <p className="mt-2 text-xs text-fg-muted" data-testid="security-findings-shown">
                  The {findings.length} worst of {data.security_open_total} open security findings.
                </p>
              )}
              {(data.experimental_open ?? 0) > 0 && (
                <p className="mt-2 text-xs text-fg-muted" data-testid="security-findings-trial">
                  +{data.experimental_open} from rules in trial, not counted here.
                </p>
              )}
              {data.open_total > findings.length && (
                <Link
                  to="/repos/$repoId/findings"
                  params={{ repoId }}
                  search={{} as never}
                  className="mt-2 inline-block text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid="security-findings-all"
                >
                  All {data.open_total} open findings for this repository, of every kind
                </Link>
              )}
            </>
          ))}
      </WidgetFrame>

      {/* W19-10: the AI review pass - start one, watch it, and see what it did
          and did not cover. Its answers appear on the findings. */}
      {/* W24-04 (UX review: the AI panel was buried here, under the scanner
          table and the open findings). It has its own tab now; one line says
          where it went, for people who learned to look here. */}
      <p className="text-xs text-fg-muted" data-testid="security-ai-pass-moved">
        The AI review pass (start a pass, its history and its schedule) is on the{' '}
        <Link
          to="/repos/$repoId/ai-review"
          params={{ repoId } as never}
          className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          AI review tab
        </Link>
        .
      </p>

      {/* W18-22: the holes beside the scanner table — languages, skipped
          files, absent scanners, shadow rules. */}
      <CoverageMap repoId={repoId} />

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
              // W20-03 (FND-04) kept the drill-down to this repository; W20-20
              // (DSH-33) sends it to the repository's own Findings tab.
              to="/repos/$repoId/findings"
              params={{ repoId }}
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
              <p
                className="text-sm text-fg-muted"
                data-testid="cves-empty"
                data-state={dependencyScanner?.state ?? 'unregistered'}
              >
                {/* Named cause, from the scanner's own state — never one fixed
                    excuse over every case (W17-20). */}
                {dependencyEmptyCopy(dependencyScanner)}
              </p>
            ) : (
              <table className="table-plain w-full text-sm" data-testid="cve-table">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th scope="col">CVE</th>
                    <th scope="col">Package</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Reachable?</th>
                    <th scope="col">Fixed in</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cves.map((cve) => (
                    <tr
                      key={cve.finding_id ?? `${cve.cve_id}|${cve.package}`}
                      className="border-t border-border"
                    >
                      <th scope="row" className="text-left font-normal">
                        {/* W20-08 (FND-56): each row opens its finding, where
                            the reachability and the VEX form are. */}
                        {cve.finding_id ? (
                          <Link
                            to="/repos/$repoId/findings"
                            params={{ repoId }}
                            search={{ finding: cve.finding_id } as never}
                            className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                            data-testid={`cve-link-${cve.finding_id}`}
                          >
                            {cve.cve_id}
                          </Link>
                        ) : (
                          cve.cve_id
                        )}
                        {cve.kev && (
                          <span className="ml-1 text-xs" data-testid="kev-flag">
                            ! known exploited
                          </span>
                        )}
                      </th>
                      <td>{cve.package}</td>
                      <td>
                        <FindingSeverityBadge severity={cve.severity} />
                      </td>
                      {/* W20-13 (FND-28): the scanner's own reachability tier,
                          so a row says whether the code can reach it. */}
                      <td
                        className="text-xs"
                        data-testid={`cve-reach-${cve.finding_id ?? cve.cve_id}`}
                      >
                        {reachabilityWord(cve.reachability)}
                      </td>
                      {/* W20-21 (FND-28): the version to upgrade to, from the
                          advisory; "no fix yet" is news too. */}
                      <td
                        className="font-mono text-xs"
                        data-testid={`cve-fixed-${cve.finding_id ?? cve.cve_id}`}
                      >
                        {cve.fixed_in && cve.fixed_in.length > 0 ? (
                          cve.fixed_in.join(', ')
                        ) : (
                          <span className="font-sans text-fg-muted">no fix published</span>
                        )}
                      </td>
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
            repoId={repoId}
          />
        )}
      </WidgetFrame>

      {/* W20-08 (UX_TODO FND-18): license findings and the policy behind them. */}
      <WidgetFrame title="Licenses" state="ready" testId="security-licenses">
        <LicensesPanel repoId={repoId} />
      </WidgetFrame>

      {/* W20-03 (UX_TODO FND-06): the OpenVEX export and the NOTICE-style
          attribution existed on the API with no link anywhere in the UI.
          Plain links, not fetch(): the browser streams the download and the
          server's content-disposition names the file. */}
      <WidgetFrame title="Exports" state="ready" testId="security-exports">
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <a
              href={`${API_BASE}/repos/${repoId}/vex.json`}
              download
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="download-vex"
            >
              Download VEX
            </a>{' '}
            <span className="text-xs text-fg-muted">
              OpenVEX statements recorded for this repository&apos;s dependencies.
            </span>
          </li>
          <li>
            <a
              href={`${API_BASE}/repos/${repoId}/attribution`}
              download
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="download-attribution"
            >
              Download attribution (NOTICE)
            </a>{' '}
            <span className="text-xs text-fg-muted">
              Third-party licenses, from the last SBOM the dependency scanner stored
              {dependencyScanner && !ranSuccessfully(dependencyScanner)
                ? ' (none yet: the dependency scanner has not completed a run here)'
                : ''}
              .
            </span>
          </li>
        </ul>
      </WidgetFrame>

      {/* W20-15 (UX_TODO X-09): SARIF import was API-only. */}
      {isAdmin && (
        <WidgetFrame title="Import results from another tool" state="ready" testId="security-sarif">
          <SarifImport repoId={repoId} />
        </WidgetFrame>
      )}

      <WidgetFrame title="Attack chains" state={state} testId="security-chains">
        {data && (
          <ChainsPanel chains={data.chains} computed={data.chains_computed} repoId={repoId} />
        )}
      </WidgetFrame>
    </div>
  );
}
