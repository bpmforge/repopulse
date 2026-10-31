import { useRef } from 'react';
import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { RunScanButton } from '../../../widgets/security/RunScanButton.js';
import { ScannerErrorDetail } from '../../../widgets/security/ScannerStatusList.js';
import { useScanRun, type ScanRun } from '../../../widgets/security/useScanRun.js';
import {
  hasMeasuredCount,
  lastRunText,
  scannerStateLabel,
  type ScannerState,
} from '../../../widgets/security/contracts.js';
import {
  CH_SERIES_LABEL,
  type ChScannerStatus,
  type RepoCodeHealth,
} from '../../../widgets/code-health/contracts.js';

// Repo Code Health tab (W9-06, CODE_HEALTH_SUITE.md §6, FR-CH-6).
//
// Same discipline as the Security tab: a scanner that has never run and one
// that ran clean are different sentences, and every number on this page is
// either measured or explicitly absent. Nothing here shows a zero it has not
// earned.
//
// W17-20: the API now reports the SAME state vocabulary as the security tab
// (running, stale, nothing_scanned, all_rejected included) — a scan in flight
// used to fall through to "✓ ran clean" here, with the count column showing
// the previous run's number as if it were this one's. The tab also follows a
// manual scan to its end instead of refetching once, and the complexity panel
// takes its empty sentence from the scanner's actual state.

// The Security tab's names for the same three scanners (W18-28). This table
// printed the registry keys — "code_health_tools", "anti_slop" — while the
// Security tab, one click away, listed the same rows as "Code health
// (complexity, duplication)" and "Anti-slop". An unknown key still shows as
// itself rather than disappearing.
const CH_SCANNER_NAME: Record<string, string> = {
  code_health_tools: 'Code health (complexity, duplication)',
  anti_slop: 'Anti-slop',
  logging_hygiene: 'Logging hygiene',
};

export const Route = createFileRoute('/repos/$repoId/code-health')({ component: CodeHealthTab });

/**
 * The payload as the API now sends it (W17-20): the scanner state is the full
 * security vocabulary, of which the code-health contract's four states are a
 * subset. Widened here rather than in widgets/code-health, which is outside
 * this ticket's write scope.
 */
type CodeHealthScanner = Omit<ChScannerStatus, 'state'> & { state: ScannerState };
type CodeHealthPayload = Omit<RepoCodeHealth, 'scanners'> & {
  scanners: CodeHealthScanner[];
  /** W20-24 (UX_TODO DSH-31): the workspace's ceilings. Absent on an older API. */
  targets?: Partial<Record<string, number>>;
};

/** Latest value of a series, or null when the series has no points. */
function latest(points: { value: number }[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1]?.value ?? null;
}

/**
 * Why the complexity panel is empty, in the complexity scanner's own words.
 *
 * ANSWER THE QUESTION THE TABLE ABOVE HAS ALREADY SETTLED (W16-49): the
 * screen knows which case it is in, so it says which. W17-20 finished the
 * job — "ran and found nothing" was printed for every state except
 * never_run, including a run that failed and one still in flight.
 */
export function complexityEmptyCopy(scanner: Pick<CodeHealthScanner, 'state'> | undefined): string {
  const NOT_MEASURED = 'This is not a measurement of a tidy codebase.';
  switch (scanner?.state) {
    case 'ok':
      return 'The complexity scanner ran and found no function over the threshold. This one IS a measurement of a tidy codebase.';
    case 'partial':
      return `The complexity scanner was cut short and found no function over the threshold in what it covered — an incomplete scan. ${NOT_MEASURED}`;
    case 'running':
      return `No complexity findings yet — the complexity scanner is running now. ${NOT_MEASURED}`;
    case 'stale':
      return `No complexity findings — the last complexity scan was interrupted and never finished. ${NOT_MEASURED}`;
    case 'error':
      return `No complexity findings — the last complexity scan failed, which is why; the coverage table above has the error. ${NOT_MEASURED}`;
    case 'nothing_scanned':
      return `No complexity findings — the last complexity scan covered nothing. ${NOT_MEASURED}`;
    case 'all_rejected':
      return `No complexity findings — the last scan proposed findings and every one was rejected. ${NOT_MEASURED}`;
    case 'not_enabled':
      return `No complexity findings — the complexity scanner is not enabled for this repository. ${NOT_MEASURED}`;
    case 'never_run':
    case undefined:
      return `No complexity findings — the complexity scanner has never run for this repository, which is why. ${NOT_MEASURED}`;
  }
}

/**
 * Why a rule list is empty, from its scanner's state (W20-12, UX_TODO DSH-32).
 * "No slop findings recorded" was printed when the scanner had never run —
 * the zero-vs-unmeasured rule the complexity panel already follows.
 */
export function ruleEmptyCopy(
  what: string,
  scannerName: string,
  scanner: Pick<CodeHealthScanner, 'state'> | undefined,
): string {
  const NOT_MEASURED = 'This is not a measurement.';
  switch (scanner?.state) {
    case 'ok':
      return `The ${scannerName} scanner ran and found no ${what} findings.`;
    case 'partial':
      return `No ${what} findings in what the ${scannerName} scanner covered before it was cut short. ${NOT_MEASURED}`;
    case 'running':
      return `No ${what} findings yet — the ${scannerName} scanner is running now. ${NOT_MEASURED}`;
    case 'stale':
      return `No ${what} findings — the last ${scannerName} scan was interrupted. ${NOT_MEASURED}`;
    case 'error':
      return `No ${what} findings — the last ${scannerName} scan failed; the coverage table above has the error. ${NOT_MEASURED}`;
    case 'nothing_scanned':
      return `No ${what} findings — the last ${scannerName} scan covered nothing. ${NOT_MEASURED}`;
    case 'all_rejected':
      return `No ${what} findings — every one the last ${scannerName} scan proposed was rejected. ${NOT_MEASURED}`;
    case 'not_enabled':
      return `No ${what} findings — the ${scannerName} scanner is not enabled for this repository. ${NOT_MEASURED}`;
    case 'never_run':
    case undefined:
      return `No ${what} findings — the ${scannerName} scanner has never run for this repository. ${NOT_MEASURED}`;
  }
}

/**
 * The change since the previous measurement (W20-20, UX_TODO DSH-31), in the
 * headline's own unit. Every debt signal here is lower-is-better, so a rise is
 * "worse". Null when there is no earlier point to compare with — one reading
 * is not a trend.
 */
export function debtDelta(
  points: { value: number; at: string }[] | undefined,
  opts: { ratio?: boolean; suffix?: string } = {},
): { text: string; tone: 'better' | 'worse' | 'same' } | null {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const scale = opts.ratio ? 100 : 1;
  const diff = Math.round((last.value - prev.value) * scale * 10) / 10;
  const since = `since ${prev.at.slice(0, 10)}`;
  if (diff === 0) return { text: `no change ${since}`, tone: 'same' };
  const unit = opts.ratio ? ' pts' : (opts.suffix ?? '');
  return {
    text: `${diff > 0 ? '▲ up' : '▼ down'} ${Math.abs(diff)}${unit} ${since} (${diff > 0 ? 'worse' : 'better'})`,
    tone: diff > 0 ? 'worse' : 'better',
  };
}

/**
 * Target vs current (W20-24, UX_TODO DSH-31). Every debt signal is
 * lower-is-better, so the target is a ceiling: at or under it is "within
 * target", above it says by how much. Null when no target is set or nothing
 * was measured — an unmeasured signal neither meets nor misses a target.
 */
export function targetLine(
  value: number | null,
  target: number | undefined,
  opts: { ratio?: boolean; suffix?: string } = {},
): { text: string; met: boolean } | null {
  if (target === undefined || value === null) return null;
  const scale = opts.ratio ? 100 : 1;
  const fmt = (n: number) =>
    `${Math.round(n * scale * 100) / 100}${opts.ratio ? '%' : (opts.suffix ?? '')}`;
  if (value <= target) return { text: `within target (at most ${fmt(target)})`, met: true };
  return { text: `${fmt(value - target)} over the target of ${fmt(target)}`, met: false };
}

function Headline({
  label,
  points,
  suffix,
  ratio,
  target,
}: {
  label: string;
  points: { value: number; at: string }[] | undefined;
  suffix?: string;
  /** W20-12 (UX_TODO DSH-31): a 0–1 ratio, printed as a percentage. */
  ratio?: boolean;
  /** W20-24 (UX_TODO DSH-31): the workspace's ceiling, when one is set. */
  target?: number | undefined;
}) {
  const value = latest(points);
  const unitOpts = { ...(ratio ? { ratio } : {}), ...(suffix ? { suffix } : {}) };
  const delta = debtDelta(points, unitOpts);
  const vsTarget = targetLine(value, target, unitOpts);
  return (
    <div className="flex flex-col" data-testid={`ch-headline-${label}`}>
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-lg tabular-nums">
        {/* "not measured" rather than 0: a zero here is a claim about the
            repository, and an unrun scanner has not earned it. */}
        {value === null ? (
          <span className="text-sm text-fg-muted">not measured</span>
        ) : (
          `${ratio ? Math.round(value * 1000) / 10 : Math.round(value * 100) / 100}${ratio ? '%' : (suffix ?? '')}`
        )}
      </span>
      {delta && (
        <span
          className={`text-xs ${delta.tone === 'worse' ? 'text-warn' : 'text-fg-muted'}`}
          data-testid={`ch-delta-${label}`}
        >
          {delta.text}
        </span>
      )}
      {vsTarget && (
        <span
          className={`text-xs ${vsTarget.met ? 'text-fg-muted' : 'text-warn'}`}
          data-testid={`ch-target-${label}`}
        >
          {vsTarget.met ? '✓ ' : '⚠ '}
          {vsTarget.text}
        </span>
      )}
    </div>
  );
}

function CodeHealthTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/code-health' });
  const descriptor = { endpoint: '/repos/{id}/code-health', path: { id: repoId } } as const;
  // Same ref dance as the Security tab: the poll interval is decided from the
  // payload the query is fetching.
  const intervalRef = useRef<ScanRun['refetchInterval']>(() => false);
  const { data, isLoading, isError, error, refetch } = useApiQuery<CodeHealthPayload>(descriptor, {
    refetchInterval: (latest) => intervalRef.current(latest),
  });
  const scan = useScanRun(data);
  intervalRef.current = scan.refetchInterval;

  const state = frameState({ isLoading, isError, isEmpty: false });
  // W20-12 (UX_TODO DSH-31): every frame on the tab offers Retry on error.
  const retry = { onRetry: () => void refetch(), ...(error ? { error } : {}) };

  return (
    <div className="flex flex-col gap-4" data-testid="code-health-tab">
      <WidgetFrame title="Debt signals" state={state} {...retry} testId="ch-signals">
        {data && (
          <div className="flex flex-wrap gap-6" data-testid="ch-headlines">
            <Headline
              label="Duplication"
              points={data.series['ch_duplication_pct']}
              suffix="%"
              target={data.targets?.['ch_duplication_pct']}
            />
            {/* W20-12 (UX_TODO DSH-31): the unit, and ratios as percentages —
                "Revert rate 0.05" read as a twentieth of a percent. */}
            <Headline
              label="Complexity p90"
              points={data.series['ch_complexity_p90']}
              suffix=" cyclomatic"
              target={data.targets?.['ch_complexity_p90']}
            />
            <Headline
              label="Worst functions"
              points={data.series['ch_worst_fn_count']}
              target={data.targets?.['ch_worst_fn_count']}
            />
            <Headline
              label="Rework 14d"
              points={data.series['M13']}
              ratio
              target={data.targets?.['M13']}
            />
            <Headline
              label="Revert rate"
              points={data.series['M14']}
              ratio
              target={data.targets?.['M14']}
            />
          </div>
        )}
      </WidgetFrame>

      <WidgetFrame title="Coverage" state={state} {...retry} testId="ch-coverage">
        {/* W16-10 (F15). Same table, same problem: three scanners, all "has
            never run", and no way to run one. */}
        <div className="mb-3">
          <RunScanButton
            repoId={repoId}
            invalidate={[queryKeyFor(descriptor)]}
            running={scan.running}
            awaiting={scan.awaiting}
            stalled={scan.stalled}
            onStarted={scan.onStarted}
          />
        </div>
        {data && (
          <table className="table-plain w-full text-sm" data-testid="ch-scanners">
            <caption className="sr-only">Code health scanner coverage</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Scanner</th>
                <th scope="col">State</th>
                <th scope="col">Last run</th>
                <th scope="col" className="text-right">
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {data.scanners.map((scanner) => (
                <tr
                  key={scanner.key}
                  className="border-t border-border"
                  data-testid={`ch-scanner-${scanner.key}`}
                  data-state={scanner.state}
                >
                  <th scope="row" className="py-1.5 text-left font-normal">
                    {CH_SCANNER_NAME[scanner.key] ?? scanner.key}
                    {scanner.tool_versions && (
                      <span className="ml-2 text-xs text-fg-muted">
                        {Object.entries(scanner.tool_versions)
                          .map(([k, v]) => `${k}@${v}`)
                          .join(' ')}
                      </span>
                    )}
                  </th>
                  <td className="py-1.5">
                    {/* The security tab's labels, so the two screens cannot
                        describe the same scan_run row in different words. */}
                    <span data-testid={`ch-scanner-state-${scanner.key}`}>
                      {scannerStateLabel(
                        scanner.state,
                        scanner.open_findings,
                        scanner.last_run_scope,
                      )}
                    </span>
                    {scanner.error && (
                      // Verbatim, plus the build/db command when the shape is
                      // recognised — the code-health tools run in the same
                      // image as the security ones and fail the same way.
                      <ScannerErrorDetail scannerKey={scanner.key} error={scanner.error} />
                    )}
                  </td>
                  <td className="py-1.5">
                    {scanner.last_run_at
                      ? lastRunText(
                          new Date(scanner.last_run_at).toLocaleDateString(),
                          scanner.last_run_scope,
                        )
                      : 'never'}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {/* A dash unless the run produced a count: null from the
                        API, and any state where the number would be a claim
                        about a scan that is not finished or measured nothing. */}
                    {scanner.open_findings === null || !hasMeasuredCount(scanner.state)
                      ? '—'
                      : scanner.open_findings}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </WidgetFrame>

      <div className="grid gap-4 md:grid-cols-2">
        <WidgetFrame title="Most complex functions" state={state} {...retry} testId="ch-complexity">
          {data &&
            (data.worst_complexity.length === 0 ? (
              <p className="text-sm text-fg-muted" data-testid="ch-complexity-empty">
                {complexityEmptyCopy(data.scanners.find((s) => s.key === 'code_health_tools'))}
              </p>
            ) : (
              <ol className="flex flex-col gap-1 text-sm" data-testid="ch-complexity-list">
                {data.worst_complexity.map((item) => (
                  <li key={item.finding_id} className="flex justify-between gap-2">
                    {/* W20-12 (UX_TODO DSH-33): the repo's own Findings tab, so
                        the trail stays "… › payments › Findings". */}
                    <Link
                      to="/repos/$repoId/findings"
                      params={{ repoId }}
                      search={{ finding: item.finding_id } as never}
                      className="truncate underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      data-testid={`ch-complexity-${item.finding_id}`}
                    >
                      {item.file}:{item.line}
                    </Link>
                    <span className="shrink-0 text-fg-muted">{item.evidence}</span>
                  </li>
                ))}
              </ol>
            ))}
        </WidgetFrame>

        <WidgetFrame title="Slop and logging by rule" state={state} {...retry} testId="ch-rules">
          {data && (
            <div className="flex flex-col gap-3 text-sm">
              <RuleList
                title="Structural slop"
                rules={data.slop_by_rule}
                testId="ch-slop-rules"
                repoId={repoId}
                emptyMessage={ruleEmptyCopy(
                  'slop',
                  'anti-slop',
                  data.scanners.find((s) => s.key === 'anti_slop'),
                )}
              />
              <RuleList
                title="Logging hygiene"
                rules={data.logging_by_rule}
                testId="ch-logging-rules"
                repoId={repoId}
                emptyMessage={ruleEmptyCopy(
                  'logging',
                  'logging hygiene',
                  data.scanners.find((s) => s.key === 'logging_hygiene'),
                )}
              />
            </div>
          )}
        </WidgetFrame>
      </div>
    </div>
  );
}

function RuleList({
  title,
  rules,
  testId,
  emptyMessage,
  repoId,
}: {
  title: string;
  rules: { rule: string; count: number }[];
  testId: string;
  emptyMessage: string;
  repoId: string;
}) {
  return (
    <section data-testid={testId}>
      <h3 className="text-xs uppercase tracking-wide text-fg-muted">{title}</h3>
      {rules.length === 0 ? (
        <p className="text-sm text-fg-muted">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col">
          {rules.map((rule) => (
            <li key={rule.rule} className="flex justify-between">
              {/* W20-12 (UX_TODO DSH-32): each rule opens the repo's findings
                  filtered to it — the ids were plain text. */}
              <Link
                to="/repos/$repoId/findings"
                params={{ repoId }}
                search={(prev: Record<string, unknown>) => ({ ...prev, rule_id: rule.rule })}
                className="truncate underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`ch-rule-${rule.rule}`}
              >
                {rule.rule}
              </Link>
              <span className="tabular-nums">{rule.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export { CH_SERIES_LABEL };
