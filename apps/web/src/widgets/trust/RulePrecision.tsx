import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import {
  benchmarkText,
  isPrecisionReport,
  LIFECYCLE_LABEL,
  triageText,
  type PrecisionText,
  type RulePrecisionReport,
} from './contracts.js';

// Per-rule precision (W18-22, E13.5).
//
// Two measurements, shown side by side and never merged: how often THIS
// workspace's reviewers called a rule's findings wrong, and how often the rule
// was wrong on the labelled benchmark corpus. Each carries its sample size and
// its source, because "100%" over one finding and "100%" over two hundred are
// not the same claim, and a reader can only tell them apart if both numbers
// are on the screen. A rule with no measurement says so in words.

export function PrecisionValue({ text, testId }: { text: PrecisionText; testId: string }) {
  return (
    <div data-testid={testId} data-measured={text.measured}>
      <span className={text.measured ? 'tabular-nums' : 'text-fg-muted'}>{text.value}</span>
      {text.small && (
        <span className="ml-1 text-xs text-fg-muted" data-testid={`${testId}-small`}>
          (small sample)
        </span>
      )}
      <div className="text-xs text-fg-faint">{text.basis}</div>
    </div>
  );
}

const ALL = { endpoint: '/rules/precision' } as const;

/** Every rule this workspace can say something about — the rules screen table. */
export function RulePrecisionTable() {
  const { data, isLoading, isError, error } = useApiQuery<RulePrecisionReport>(ALL);
  const report = isPrecisionReport(data) ? data : null;
  const rules = report?.rules ?? [];
  const state = frameState({ isLoading, isError, isEmpty: !isLoading && rules.length === 0 });

  return (
    <WidgetFrame
      title="Rule precision"
      state={state}
      {...(error ? { error } : {})}
      emptyMessage="No rule has raised a finding here, sits in the registry, or was scored by the benchmark — so there is no precision to show for any rule yet."
      testId="rule-precision-frame"
    >
      {report && (
        <>
          <p className="mb-2 text-xs text-fg-muted">
            Two separate measurements. <strong>Your triage</strong>: the share of triaged findings
            nobody dismissed as a false positive. <strong>Benchmark</strong>: the share of findings
            that were real on the {report.benchmark.ticket} labelled corpus
            {report.benchmark.excludedSuites.length > 0 &&
              ` (excluding ${report.benchmark.excludedSuites.map((s) => s.suite).join(', ')}: ${report.benchmark.excludedSuites[0]!.reason.toLowerCase().replace(/\.$/, '')})`}
            . Neither is averaged into the other.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="rule-precision-table">
              <caption className="sr-only">Measured precision per rule, by source</caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col" className="pr-2">
                    Rule
                  </th>
                  <th scope="col" className="pr-2">
                    State
                  </th>
                  <th scope="col" className="pr-3 text-right">
                    Findings here
                  </th>
                  <th scope="col" className="pr-2">
                    Your triage
                  </th>
                  <th scope="col">Benchmark</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr
                    key={rule.ruleId}
                    className="border-t border-border align-top"
                    data-testid={`precision-row-${rule.ruleId}`}
                    data-lifecycle={rule.lifecycle}
                  >
                    <th scope="row" className="py-2 pr-2 text-left font-mono text-xs font-normal">
                      {rule.ruleId}
                    </th>
                    <td className="py-2 pr-2 text-xs">
                      {LIFECYCLE_LABEL[rule.lifecycle]}
                      <div className="text-fg-faint">from {rule.lifecycleSource}</div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{rule.findings}</td>
                    <td className="py-2 pr-2">
                      <PrecisionValue
                        text={triageText(rule.triage)}
                        testId={`precision-triage-${rule.ruleId}`}
                      />
                    </td>
                    <td className="py-2">
                      <PrecisionValue
                        text={benchmarkText(rule.benchmark, report.benchmark)}
                        testId={`precision-bench-${rule.ruleId}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </WidgetFrame>
  );
}

/** One rule's record, for the finding drawer. */
export function RulePrecisionSummary({ ruleId }: { ruleId: string }) {
  const { data, isLoading, isError } = useApiQuery<RulePrecisionReport>({
    endpoint: '/rules/precision',
    query: { rule_id: ruleId },
  });
  const report = isPrecisionReport(data) ? data : null;
  const rule = report?.rules.find((r) => r.ruleId === ruleId);

  return (
    <div data-testid="finding-rule-precision">
      <h3 className="text-xs tracking-wide text-fg-muted uppercase">
        Rule <span className="font-mono normal-case">{ruleId}</span>
      </h3>
      {isLoading && <p className="mt-1 text-xs text-fg-muted">Loading this rule’s record…</p>}
      {!isLoading && (isError || !report || !rule) && (
        // Said, not hidden: a drawer that silently drops the section reads as
        // "this rule has no record", which is a claim nobody checked.
        <p className="mt-1 text-xs text-fg-muted" data-testid="finding-rule-precision-unavailable">
          This rule’s precision could not be loaded.
        </p>
      )}
      {report && rule && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-xs text-fg-muted">State</dt>
          <dd data-testid="finding-rule-lifecycle">
            {LIFECYCLE_LABEL[rule.lifecycle]}
            <span className="ml-1 text-xs text-fg-faint">(from {rule.lifecycleSource})</span>
          </dd>
          <dt className="text-xs text-fg-muted">Your triage</dt>
          <dd>
            <PrecisionValue text={triageText(rule.triage)} testId="finding-rule-triage" />
          </dd>
          <dt className="text-xs text-fg-muted">Benchmark</dt>
          <dd>
            <PrecisionValue
              text={benchmarkText(rule.benchmark, report.benchmark)}
              testId="finding-rule-bench"
            />
          </dd>
        </dl>
      )}
    </div>
  );
}
