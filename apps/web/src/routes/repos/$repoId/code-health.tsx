import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../../api/useApiQuery.js';
import { RunScanButton } from '../../../widgets/security/RunScanButton.js';
import {
  CH_SCANNER_STATE_LABEL,
  CH_SERIES_LABEL,
  type RepoCodeHealth,
} from '../../../widgets/code-health/contracts.js';

// Repo Code Health tab (W9-06, CODE_HEALTH_SUITE.md §6, FR-CH-6).
//
// Same discipline as the Security tab: a scanner that has never run and one
// that ran clean are different sentences, and every number on this page is
// either measured or explicitly absent. Nothing here shows a zero it has not
// earned.

export const Route = createFileRoute('/repos/$repoId/code-health')({ component: CodeHealthTab });

/** Latest value of a series, or null when the series has no points. */
function latest(points: { value: number }[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1]?.value ?? null;
}

function Headline({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | null;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col" data-testid={`ch-headline-${label}`}>
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-lg tabular-nums">
        {/* "not measured" rather than 0: a zero here is a claim about the
            repository, and an unrun scanner has not earned it. */}
        {value === null ? (
          <span className="text-sm text-fg-muted">not measured</span>
        ) : (
          `${Math.round(value * 100) / 100}${suffix ?? ''}`
        )}
      </span>
    </div>
  );
}

function CodeHealthTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/code-health' });
  const { data, isLoading, isError, error } = useApiQuery<RepoCodeHealth>({
    endpoint: '/repos/{id}/code-health',
    path: { id: repoId },
  });

  const state = frameState({ isLoading, isError, isEmpty: false });

  return (
    <div className="flex flex-col gap-4" data-testid="code-health-tab">
      <WidgetFrame
        title="Debt signals"
        state={state}
        {...(error ? { errorMessage: error.message } : {})}
        testId="ch-signals"
      >
        {data && (
          <div className="flex flex-wrap gap-6" data-testid="ch-headlines">
            <Headline
              label="Duplication"
              value={latest(data.series['ch_duplication_pct'])}
              suffix="%"
            />
            <Headline label="Complexity p90" value={latest(data.series['ch_complexity_p90'])} />
            <Headline label="Worst functions" value={latest(data.series['ch_worst_fn_count'])} />
            <Headline label="Rework 14d" value={latest(data.series['M13'])} />
            <Headline label="Revert rate" value={latest(data.series['M14'])} />
          </div>
        )}
      </WidgetFrame>

      <WidgetFrame title="Coverage" state={state} testId="ch-coverage">
        {/* W16-10 (F15). Same table, same problem: three scanners, all "has
            never run", and no way to run one. */}
        <div className="mb-3">
          <RunScanButton
            repoId={repoId}
            invalidate={[queryKeyFor({ endpoint: '/repos/{id}/code-health', path: { id: repoId } })]}
          />
        </div>
        {data && (
          <table className="w-full text-sm" data-testid="ch-scanners">
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
                    {scanner.key}
                    {scanner.tool_versions && (
                      <span className="ml-2 text-xs text-fg-muted">
                        {Object.entries(scanner.tool_versions)
                          .map(([k, v]) => `${k}@${v}`)
                          .join(' ')}
                      </span>
                    )}
                  </th>
                  <td className="py-1.5">{CH_SCANNER_STATE_LABEL[scanner.state]}</td>
                  <td className="py-1.5">
                    {scanner.last_run_at
                      ? new Date(scanner.last_run_at).toLocaleDateString()
                      : 'never'}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {scanner.open_findings === null ? '—' : scanner.open_findings}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </WidgetFrame>

      <div className="grid gap-4 md:grid-cols-2">
        <WidgetFrame title="Most complex functions" state={state} testId="ch-complexity">
          {data &&
            (data.worst_complexity.length === 0 ? (
              <p className="text-sm text-fg-muted" data-testid="ch-complexity-empty">
                No complexity findings. If the coverage table above says the scanner has never run,
                that is why — this is not a measurement of a tidy codebase.
              </p>
            ) : (
              <ol className="flex flex-col gap-1 text-sm" data-testid="ch-complexity-list">
                {data.worst_complexity.map((item) => (
                  <li key={item.finding_id} className="flex justify-between gap-2">
                    <Link
                      to="/findings"
                      search={{ open: item.finding_id } as never}
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

        <WidgetFrame title="Slop and logging by rule" state={state} testId="ch-rules">
          {data && (
            <div className="flex flex-col gap-3 text-sm">
              <RuleList
                title="Structural slop"
                rules={data.slop_by_rule}
                testId="ch-slop-rules"
                emptyMessage="No slop findings recorded for this repository."
              />
              <RuleList
                title="Logging hygiene"
                rules={data.logging_by_rule}
                testId="ch-logging-rules"
                emptyMessage="No logging findings recorded for this repository."
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
}: {
  title: string;
  rules: { rule: string; count: number }[];
  testId: string;
  emptyMessage: string;
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
              <span className="truncate">{rule.rule}</span>
              <span className="tabular-nums">{rule.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export { CH_SERIES_LABEL };
