import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { apiFetch, buildUrl } from '../../api/client.js';
import {
  RULE_STATUS_LABEL,
  RULE_TRANSITIONS,
  ruleAction,
  type RuleLifecycleStatus,
  type RuleRow,
} from '../../widgets/rules/contracts.js';
import { RulePrecisionTable } from '../../widgets/trust/RulePrecision.js';
import { ProposeRuleForm } from '../../widgets/rules/ProposeRuleForm.js';

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

// W20-03 (UX_TODO FND-15): Deprecate was drawn as the primary (accent) action.
// A forward step keeps the accent; a destructive one is neutral, so the
// visually suggested button is never the one that stops a rule.
const FORWARD =
  'rounded-md border border-accent bg-accent/10 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const NEUTRAL =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

type Move = { ruleId: string; from: RuleLifecycleStatus; to: RuleLifecycleStatus };

export function RuleWorkbench() {
  const { data, isLoading, isError, error } = useApiQuery<{ items: RuleRow[] }>(LIST);
  const queryClient = useQueryClient();
  // W20-01 (UX_TODO FND-69): this was a useApiMutation with the template
  // `/rules/{ruleId}/transition` and the id only in the body, so every press
  // hit the literal `{ruleId}` URL and 404'd — silently, since nothing showed
  // the error. The id goes in the PATH now, per row, and failures are shown.
  /**
   * The move waiting for a yes, and what the last one did (W20-03, FND-15).
   * Promote and every destructive step acted on one click, with nothing said
   * afterwards; a rule going live or stopping changes what every later scan
   * says about someone's code, which deserves a second look and a receipt.
   */
  const [confirming, setConfirming] = useState<Move | null>(null);
  const [message, setMessage] = useState<{ ruleId: string; text: string } | null>(null);
  /** W20-08 (UX_TODO FND-65): the "Propose a rule" form, open or not. */
  const [proposing, setProposing] = useState(false);
  const transition = useMutation<unknown, Error, Move>({
    mutationFn: ({ ruleId, to }) =>
      apiFetch<unknown>(buildUrl('/rules/{ruleId}/transition', { path: { ruleId } }), {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: async (_result, move) => {
      setMessage({ ruleId: move.ruleId, text: ruleAction(move.from, move.to).done });
      await queryClient.invalidateQueries({ queryKey: queryKeyFor(LIST) });
    },
  });

  /** Ask first where the move says to; otherwise send it. */
  const request = (move: Move) => {
    setMessage(null);
    if (ruleAction(move.from, move.to).confirm) setConfirming(move);
    else transition.mutate(move);
  };

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
        // W20-08 (UX_TODO FND-65): it said rules were "drafted from your own
        // findings" while nothing drafted them. They arrive by a person
        // proposing one (below, or from a finding), or as a tool row the first
        // time a shadow tool such as checkov raises a finding.
        emptyMessage="No rules in the registry yet. A rule gets here when an admin proposes one (Propose a rule, below, or from a finding's panel), or the first time a shadow tool such as checkov or hadolint raises a finding. Rules here run in shadow before they may count; the rules that ship in the scanners' packs are always on and are not listed."
        testId="rules-frame"
      >
        {message && (
          <p className="mb-2 text-sm" role="status" data-testid="rule-status-message">
            <span className="font-mono">{message.ruleId}</span>: {message.text}
          </p>
        )}
        <table className="table-plain w-full text-sm" data-testid="rules-table">
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
                      {/* The demotion action beside the flag (FND-16). §8.2
                          makes demotion an admin-confirmed deprecation. */}
                      {rule.status === 'active' && (
                        <button
                          type="button"
                          className={`${NEUTRAL} ml-2`}
                          data-testid={`rule-demote-action-${rule.rule_id}`}
                          disabled={transition.isPending}
                          onClick={() =>
                            request({ ruleId: rule.rule_id, from: 'active', to: 'deprecated' })
                          }
                        >
                          Demote (deprecate)
                        </button>
                      )}
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
                  {/* Every move the lifecycle allows from here (FND-16), not
                      one forward step: a proposed or shadow rule can now be
                      rejected or retired. */}
                  <div className="flex flex-wrap gap-1">
                    {RULE_TRANSITIONS[rule.status].map((to) => {
                      const action = ruleAction(rule.status, to);
                      return (
                        <button
                          key={to}
                          type="button"
                          className={action.destructive ? NEUTRAL : FORWARD}
                          data-testid={`rule-move-${to}-${rule.rule_id}`}
                          disabled={
                            transition.isPending || (to === 'active' && !rule.promotion.eligible)
                          }
                          onClick={() => request({ ruleId: rule.rule_id, from: rule.status, to })}
                        >
                          {action.label}
                        </button>
                      );
                    })}
                  </div>
                  {confirming?.ruleId === rule.rule_id && (
                    <div
                      className="mt-1 flex flex-wrap items-center gap-1 text-xs"
                      role="alertdialog"
                      aria-label={`Confirm: ${ruleAction(confirming.from, confirming.to).label}`}
                      data-testid={`rule-confirm-${rule.rule_id}`}
                    >
                      <span>{ruleAction(confirming.from, confirming.to).confirm}</span>
                      <button
                        type="button"
                        className={NEUTRAL}
                        data-testid={`rule-confirm-yes-${rule.rule_id}`}
                        onClick={() => {
                          transition.mutate(confirming);
                          setConfirming(null);
                        }}
                      >
                        {ruleAction(confirming.from, confirming.to).label}
                      </button>
                      <button
                        type="button"
                        className={NEUTRAL}
                        data-testid={`rule-confirm-no-${rule.rule_id}`}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {transition.variables?.ruleId === rule.rule_id && (
                    <ErrorNote
                      error={transition.error}
                      className="mt-1"
                      testId={`rule-error-${rule.rule_id}`}
                    />
                  )}
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
      <div className="flex flex-col gap-2" data-testid="propose-rule">
        {proposing ? (
          <ProposeRuleForm onClose={() => setProposing(false)} />
        ) : (
          <div>
            <button
              type="button"
              className={FORWARD}
              data-testid="propose-rule-open"
              onClick={() => setProposing(true)}
            >
              Propose a rule
            </button>
          </div>
        )}
      </div>
      {/* W18-22: every rule's measured precision and lifecycle, including the
          pack rules this registry does not hold. */}
      <RulePrecisionTable />
    </div>
  );
}
