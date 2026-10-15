import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import {
  RULE_NEXT_STATUS,
  RULE_NEXT_STEP,
  RULE_STATUS_LABEL,
  type RuleRow,
} from '../../widgets/rules/contracts.js';
import { RulePrecisionTable } from '../../widgets/trust/RulePrecision.js';

// Rule workbench (W9-07, CODE_HEALTH_SUITE.md §8, FR-CH-8, FR-AUTH-4).
//
// The screen exists to make one decision answerable: should this rule start
// counting? Everything on a row is evidence for that — how much it found, how
// long it has been watching, how often people said it was wrong — and the
// promote button stays disabled with its REASONS visible rather than being
// hidden, because "why can I not do this" is the question an admin actually
// has.

export const Route = createFileRoute('/admin/rules')({ component: RuleWorkbench });

const LIST = { endpoint: '/rules' } as const;

function RuleWorkbench() {
  const { data, isLoading, isError, error } = useApiQuery<{ items: RuleRow[] }>(LIST);
  const transition = useApiMutation<{ ruleId: string; to: string }, unknown>(
    { endpoint: '/rules/{ruleId}/transition', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );

  const items = data?.items ?? [];
  const state = frameState({ isLoading, isError, isEmpty: items.length === 0 });

  return (
    <div className="flex flex-col gap-4" data-testid="rule-workbench">
      <WidgetFrame
        title="Rule registry"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        // NAME WHAT THIS REGISTRY IS (W16-57). It said "Rules ship in
        // versioned packs; this screen governs which of them count", which
        // reads as though every rule the scanners apply should be listed
        // here — so a reader who has just seen a finding attributed to
        // `bpm-log-console-in-prod` concludes the screen is broken. It holds
        // only CANDIDATE rules drafted from this workspace's own findings,
        // working through shadow before they are allowed to count.
        emptyMessage="No candidate rules yet. This registry holds rules DRAFTED from your own findings, which run in shadow before they are allowed to raise anything — the rules that ship in the scanners' packs are always on and are not listed here."
        testId="rules-frame"
      >
        <table className="w-full text-sm" data-testid="rules-table">
          <caption className="sr-only">Rule lifecycle and promotion evidence</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Rule</th>
              <th scope="col">State</th>
              <th scope="col">Provenance</th>
              <th scope="col" className="text-right">
                Findings
              </th>
              <th scope="col" className="text-right">
                FP rate
              </th>
              <th scope="col">Next</th>
            </tr>
          </thead>
          <tbody>
            {items.map((rule) => (
              <tr
                key={rule.rule_id}
                className="border-t border-border align-top"
                data-testid={`rule-row-${rule.rule_id}`}
                data-status={rule.status}
              >
                <th scope="row" className="py-2 text-left font-normal">
                  {rule.rule_id}
                  {rule.demotion_candidate && (
                    <span className="ml-2 text-xs" data-testid={`rule-demote-${rule.rule_id}`}>
                      ! demotion candidate
                    </span>
                  )}
                </th>
                <td className="py-2">{RULE_STATUS_LABEL[rule.status]}</td>
                <td className="py-2 text-xs text-fg-muted">
                  {rule.provenance.source} · {rule.provenance.license}
                </td>
                <td className="py-2 text-right tabular-nums">{rule.evidence.findings}</td>
                <td className="py-2 text-right tabular-nums">
                  {/* "not triaged" rather than 0%: a 0% false-positive rate
                      across nothing reads as a flawless rule. */}
                  {rule.evidence.fpRate === null
                    ? 'not triaged'
                    : `${Math.round(rule.evidence.fpRate * 100)}%`}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    className="rounded-md border border-accent bg-accent/10 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                    data-testid={`rule-advance-${rule.rule_id}`}
                    disabled={rule.status === 'candidate' && !rule.promotion.eligible}
                    onClick={() =>
                      transition.mutate({
                        ruleId: rule.rule_id,
                        to: RULE_NEXT_STATUS[rule.status],
                      })
                    }
                  >
                    {RULE_NEXT_STEP[rule.status]}
                  </button>
                  {rule.status === 'candidate' && rule.promotion.reasons.length > 0 && (
                    <ul
                      className="mt-1 text-xs text-fg-muted"
                      data-testid={`rule-blockers-${rule.rule_id}`}
                    >
                      {rule.promotion.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetFrame>
      {/* W18-22: every rule's measured precision and lifecycle, including the
          pack rules this registry does not hold. */}
      <RulePrecisionTable />
    </div>
  );
}
