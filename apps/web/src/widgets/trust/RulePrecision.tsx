import { WidgetFrame, frameState } from '../../components/index.js';
import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery } from '../../api/useApiQuery.js';
import { RuleFindingsLink } from '../rules/RuleFindingsLink.js';
import {
  evidenceText,
  isPrecisionReport,
  LIFECYCLE_LABEL,
  triageText,
  type PrecisionText,
  type RulePrecision,
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

const rate = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

/**
 * Accuracy on the public SAST benchmarks, per CWE, in the Benchmark's own units
 * (W18-40). Every CWE we were scored on is listed, including those where the
 * detection rate is 0%: leaving out the bad rows would turn a measurement into
 * marketing.
 */
export function PublicBenchmarkTable({
  benchmark,
}: {
  benchmark: RulePrecisionReport['benchmark'];
}) {
  const cwes = benchmark.cwes ?? [];
  if (cwes.length === 0) {
    return (
      <p className="mb-3 text-xs text-fg-muted" data-testid="public-benchmark-empty">
        No public benchmark (OWASP Benchmark, Juliet) has been run yet, so there are no published
        per-CWE accuracy numbers.
      </p>
    );
  }
  const titles = new Map((benchmark.publicSuites ?? []).map((s) => [s.id, s.title]));
  const measured = benchmark.measured;
  return (
    <section className="mb-4" data-testid="public-benchmark">
      <h3 className="text-sm font-medium">Accuracy on public SAST benchmarks</h3>
      <p className="mb-2 text-xs text-fg-muted">
        Measured {measured?.date ?? 'on an unrecorded date'}
        {benchmark.engine ? ` with ${benchmark.engine}` : ''}. <strong>Detected</strong> is the
        share of real vulnerabilities found; <strong>False alarms</strong> is the share of safe
        look-alikes flagged; <strong>Score</strong> is Detected − False alarms (0 is a coin flip,
        negative is worse than guessing). A weakness we have no rule for shows 0% detected.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="public-benchmark-table">
          <caption className="sr-only">Detection and false alarm rate per CWE</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col" className="pr-2">
                Benchmark
              </th>
              <th scope="col" className="pr-2">
                CWE
              </th>
              <th scope="col" className="pr-2 text-right">
                Detected
              </th>
              <th scope="col" className="pr-2 text-right">
                False alarms
              </th>
              <th scope="col" className="text-right">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {cwes.map((c) => (
              <tr
                key={`${c.suite}-${c.cwe}`}
                className="border-t border-border"
                data-testid={`public-benchmark-${c.suite}-${c.cwe}`}
              >
                <th scope="row" className="py-1 pr-2 text-left text-xs font-normal">
                  {titles.get(c.suite) ?? c.suite}
                </th>
                <td className="py-1 pr-2 tabular-nums">CWE-{c.cwe}</td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {rate(c.tpr)}
                  <span className="text-xs text-fg-faint">
                    {' '}
                    ({c.tp} of {c.tp + c.fn})
                  </span>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {rate(c.fpr)}
                  <span className="text-xs text-fg-faint">
                    {' '}
                    ({c.fp} of {c.fp + c.tn})
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  {c.youden === null ? '—' : c.youden.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ALL = { endpoint: '/rules/precision' } as const;

/** Every rule this workspace can say something about — the rules screen table. */
export function RulePrecisionTable() {
  const { data, isLoading, isError, error } = useApiQuery<RulePrecisionReport>(ALL);
  const report = isPrecisionReport(data) ? data : null;
  const rules = report?.rules ?? [];
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
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
          <PublicBenchmarkTable benchmark={report.benchmark} />
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
                  <th scope="col">Evidence</th>
                  {isAdmin && (
                    <th scope="col" className="pl-2">
                      In this workspace
                    </th>
                  )}
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
                      {/* W20-13 (FND-40): to the findings this rule raised. */}
                      <RuleFindingsLink ruleId={rule.ruleId} />
                    </th>
                    <td className="py-2 pr-2 text-xs">
                      {LIFECYCLE_LABEL[rule.lifecycle]}
                      <div className="text-fg-faint">
                        <StageReason rule={rule} />
                      </div>
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
                        text={evidenceText(rule, report.benchmark)}
                        testId={`precision-bench-${rule.ruleId}`}
                      />
                    </td>
                    {isAdmin && (
                      <td className="py-2 pl-2">
                        <PackOverride rule={rule} />
                      </td>
                    )}
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
      <h3 className="section-label">
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
            <span className="ml-1 text-xs text-fg-faint">
              (<StageReason rule={rule} />)
            </span>
          </dd>
          <dt className="text-xs text-fg-muted">Your triage</dt>
          <dd>
            <PrecisionValue text={triageText(rule.triage)} testId="finding-rule-triage" />
          </dd>
          <dt className="text-xs text-fg-muted">Benchmark</dt>
          <dd>
            <PrecisionValue
              text={evidenceText(rule, report.benchmark)}
              testId="finding-rule-bench"
            />
          </dd>
        </dl>
      )}
    </div>
  );
}

/**
 * Why a rule is in its state (W21-04). A starter-set rule says so, with the
 * benchmark numbers that put it there; everything else names its source.
 */
export function StageReason({
  rule,
}: {
  rule: Pick<RulePrecision, 'ruleId' | 'lifecycleSource' | 'starter'>;
}) {
  if (!rule.starter) return <>from {rule.lifecycleSource}</>;
  const { evidence } = rule.starter;
  const suites = evidence.suites
    .map((s) => `${s.suite}${s.trees ? ` (${s.trees.join(', ')})` : ''} ${s.tp} TP / ${s.fp} FP`)
    .join('; ');
  return (
    <span
      data-testid={`stage-reason-starter-${rule.ruleId}`}
      title={`${(evidence.precision * 100).toFixed(1)}% precision, ${evidence.tp} TP / ${evidence.fp} FP: ${suites}`}
    >
      {rule.starter.reason}
    </span>
  );
}

const OVERRIDE_REASON_MIN = 10;

/**
 * Move a noisy shipped rule to shadow here, or put it back (W20-21, UX_TODO
 * FND-53). Shadow keeps the rule running and its findings visible under the
 * shadow facet, out of every count, while its precision is measured; Restore
 * deletes the override and the rule counts again. Admin only, as the API is.
 */
export function PackOverride({
  rule,
}: {
  rule: { ruleId: string; lifecycle: string; override?: boolean; starter?: unknown };
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const invalidate = [[ALL.endpoint]] as const;
  const shadow = useApiMutation<{ reason: string }, unknown>(
    { endpoint: '/rules/{ruleId}/pack-override', path: { ruleId: rule.ruleId }, method: 'POST' },
    { invalidate },
  );
  const restore = useApiMutation<Record<string, never>, unknown>(
    { endpoint: '/rules/{ruleId}/pack-override', path: { ruleId: rule.ruleId }, method: 'DELETE' },
    { invalidate },
  );
  const link =
    'text-xs text-accent underline underline-offset-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  if (rule.override) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-fg-muted">Moved to shadow here</span>
        <button
          type="button"
          className={`${link} self-start`}
          data-testid={`pack-restore-${rule.ruleId}`}
          disabled={restore.isPending}
          onClick={() => restore.mutate({})}
        >
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
        <ErrorNote error={restore.error} testId={`pack-restore-error-${rule.ruleId}`} />
      </div>
    );
  }
  // A starter-set rule is live by shipped default, like a pack rule, so the
  // same override moves it to shadow here (W21-04).
  if (rule.lifecycle !== 'pack' && !rule.starter) {
    return <span className="text-xs text-fg-faint">—</span>;
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      {!open ? (
        <button
          type="button"
          className={`${link} self-start`}
          data-testid={`pack-shadow-${rule.ruleId}`}
          title="Keep running this shipped rule but stop counting its findings here while its precision is measured."
          onClick={() => setOpen(true)}
        >
          Move to shadow
        </button>
      ) : (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            shadow.mutate({ reason: reason.trim() }, { onSuccess: () => setOpen(false) });
          }}
        >
          <label className="flex flex-col gap-1 text-fg-muted">
            Why (at least {OVERRIDE_REASON_MIN} characters)
            <input
              className="panel w-56 px-2 py-1 text-sm"
              data-testid={`pack-shadow-reason-${rule.ruleId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <span className="flex gap-2">
            <button
              type="submit"
              className={link}
              data-testid={`pack-shadow-submit-${rule.ruleId}`}
              disabled={shadow.isPending || reason.trim().length < OVERRIDE_REASON_MIN}
            >
              {shadow.isPending ? 'Moving…' : 'Move to shadow'}
            </button>
            <button
              type="button"
              className="text-fg-muted underline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </span>
        </form>
      )}
      <ErrorNote error={shadow.error} testId={`pack-shadow-error-${rule.ruleId}`} />
    </div>
  );
}
