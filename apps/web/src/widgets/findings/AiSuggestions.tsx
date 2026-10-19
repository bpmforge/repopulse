import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import {
  passLabel,
  routeLabel,
  VERDICT_SENTENCE,
  type AiSuggestion,
  type FindingAi,
} from './aiContracts.js';

// AI suggestions in the finding drawer (W19-10).
//
// Everything here is a SUGGESTION from a model, and says so. A person answers it
// (accept or dismiss), and that answer is recorded against the suggestion,
// with who and when. Answering NEVER moves the finding: agreeing that a finding
// looks like a false positive offers the existing Dismiss action, prefilled, and
// leaves the pressing to the person (D9a - AI never suppresses).
//
// "No review recorded" is not "reviewed and fine": a finding no pass has looked at
// says it has not been looked at.

const ACTION_BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function AiBadge() {
  return (
    <span
      className="rounded-sm border border-info/50 bg-info/10 px-1.5 py-0.5 text-xs font-medium text-fg"
      data-testid="ai-badge"
    >
      AI
    </span>
  );
}

function Suggestion({
  findingId,
  s,
  invalidate,
  onOfferDismiss,
}: {
  findingId: number;
  s: AiSuggestion;
  invalidate: readonly (readonly unknown[])[];
  onOfferDismiss: () => void;
}) {
  const decide = useApiMutation<{ decision: 'accepted' | 'dismissed' }, unknown>(
    {
      endpoint: '/findings/{id}/ai-verdicts/{verdictId}/decide',
      path: { id: findingId, verdictId: s.id },
      method: 'POST',
    },
    { invalidate },
  );
  const pending = decide.isPending ? decide.variables?.decision : undefined;
  const open = s.decision === null;

  return (
    <li
      className="flex flex-col gap-2 rounded-sm border border-dashed border-info/50 px-3 py-2"
      data-testid={`ai-suggestion-${s.id}`}
      data-verdict={s.verdict}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <AiBadge />
        <span data-testid="ai-verdict">{VERDICT_SENTENCE[s.verdict]}</span>
        <span className="text-xs text-fg-muted">confidence {s.confidence}/5</span>
      </p>
      <p className="text-xs text-fg-muted" data-testid="ai-route">
        From a pass over {passLabel(s.pass ?? null)}. Produced by {routeLabel(s.route, s.model)}
        {s.checklist_version ? `, checklist ${s.checklist_version}` : ''}. A model can be wrong;
        treat this as a lead, not a result.
      </p>
      <p className="text-sm" data-testid="ai-rationale">
        {s.rationale}
      </p>

      {s.citations.length > 0 ? (
        <div data-testid="ai-citations">
          <h4 className="text-xs tracking-wide text-fg-muted uppercase">
            Cited lines (our copy of the file)
          </h4>
          <ul className="mt-1 flex flex-col gap-1">
            {s.citations.map((c, i) => (
              <li key={i}>
                <span className="font-mono text-xs text-fg-faint">
                  {c.file}:{c.line}
                </span>
                {/* Wraps rather than scrolls: a scrollable block must be keyboard-reachable
                    (axe scrollable-region-focusable, caught at 375px), and a one-line
                    citation is better read whole than panned. */}
                <pre className="panel-inset p-1 font-mono text-xs break-words whitespace-pre-wrap">
                  {c.text}
                </pre>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">The model cited no lines.</p>
      )}

      {s.vex ? (
        <p className="text-xs text-fg-muted" data-testid="ai-vex">
          Proposed VEX justification: <span className="font-mono">{s.vex.justification}</span>
          {s.vex.statement ? ` — ${s.vex.statement.replace(/[.\s]+$/, '')}` : ''}. Nothing is
          recorded as VEX until a person does it.
        </p>
      ) : null}

      <p className="text-xs text-fg-muted" data-testid="ai-patch">
        {s.patch.status === 'verified' && s.patch.diff
          ? 'A patch was proposed and verified by re-scanning. See Verified fix.'
          : s.patch.status === 'not_attempted' || !s.patch.status
            ? 'No patch was proposed or proven for this suggestion.'
            : `A proposed patch was not kept (${s.patch.reason ?? s.patch.status}).`}
      </p>

      {open ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-decide">
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="ai-agree"
            disabled={decide.isPending}
            aria-busy={pending === 'accepted' || undefined}
            onClick={() => decide.mutate({ decision: 'accepted' })}
          >
            {pending === 'accepted' ? 'Recording…' : 'Accept suggestion'}
          </button>
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="ai-disagree"
            disabled={decide.isPending}
            aria-busy={pending === 'dismissed' || undefined}
            onClick={() => decide.mutate({ decision: 'dismissed' })}
          >
            {pending === 'dismissed' ? 'Recording…' : 'Dismiss suggestion'}
          </button>
          <span className="text-xs text-fg-faint">
            Your answer is recorded on the suggestion. It does not change the finding.
          </span>
        </div>
      ) : (
        <div data-testid="ai-decided">
          <p className="text-xs text-fg-muted" role="status">
            {s.decision === 'accepted'
              ? 'Suggestion accepted'
              : s.decision === 'dismissed'
                ? 'Suggestion dismissed'
                : 'Superseded'}
            {s.decided_by ? ` by ${s.decided_by}` : ''}
            {s.decided_at ? ` on ${s.decided_at.slice(0, 10)}` : ''}.
          </p>
          {s.decision === 'accepted' && s.verdict === 'likely_false_positive' ? (
            <p className="mt-1 text-xs text-fg-muted" data-testid="ai-offer-dismiss">
              Accepting a suggestion does not dismiss the finding: it is still open.{' '}
              <button
                type="button"
                className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="ai-prefill-dismiss"
                onClick={onOfferDismiss}
              >
                Dismiss it as a false positive
              </button>{' '}
              (prefills the form below; you still write the note and press Dismiss).
            </p>
          ) : null}
        </div>
      )}
      <ErrorNote error={decide.error} testId="ai-decide-error" />
    </li>
  );
}

export function AiSuggestions({
  findingId,
  onOfferDismiss,
}: {
  findingId: number;
  /** Prefills the drawer's own dismiss form; never dismisses. */
  onOfferDismiss: () => void;
}) {
  const descriptor = { endpoint: '/findings/{id}/ai', path: { id: findingId } } as const;
  const { data, isError } = useApiQuery<FindingAi>(descriptor);
  const invalidate = [queryKeyFor(descriptor)];

  if (isError) {
    return (
      <p className="text-xs text-fg-faint" data-testid="ai-unavailable">
        AI review information could not be loaded. That says nothing about the finding.
      </p>
    );
  }
  if (!data) return null;

  // Read defensively: a body of another shape is "nothing recorded", never a crash.
  const raisedBy = data.raised_by ?? null;
  const suggestions = data.suggestions ?? [];
  return (
    <div data-testid="ai-section">
      <h3 className="text-xs tracking-wide text-fg-muted uppercase">AI review</h3>
      {raisedBy ? (
        <p className="mt-1 text-xs text-fg-muted" data-testid="ai-raised-by">
          This finding was raised by an AI specialist ({raisedBy.specialist.replace(/_/g, ' ')}),{' '}
          {routeLabel(raisedBy.route, raisedBy.model)}, in a pass over{' '}
          {passLabel(raisedBy.pass ?? null)}. A rule did not find it.
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-2">
          {suggestions.map((s) => (
            <Suggestion
              key={s.id}
              findingId={findingId}
              s={s}
              invalidate={invalidate}
              onOfferDismiss={onOfferDismiss}
            />
          ))}
        </ul>
      ) : !raisedBy ? (
        <p className="mt-1 text-xs text-fg-muted" data-testid="ai-not-run">
          Not yet run: no AI review has been recorded for this finding. An admin can start one from
          the repository&rsquo;s Security tab. This says nothing about the finding either way.
        </p>
      ) : (
        <p className="mt-1 text-xs text-fg-muted" data-testid="ai-no-verdict">
          No triage suggestion has been recorded for this finding.
        </p>
      )}
    </div>
  );
}
