import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { VEX_JUSTIFICATION_LABEL, type VexJustification } from '../security/contracts.js';
import {
  passLabel,
  routeLabel,
  specialistLabel,
  VERDICT_SENTENCE,
  type AiSuggestion,
  type AiVerdict,
  type FindingAi,
} from './aiContracts.js';
import { AskSecondOpinion, SecondOpinionAnswer } from './SecondOpinion.js';

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

/**
 * The two answers, named for what they say about THIS verdict (W20-11, UX_TODO
 * AI-41). "Accept suggestion" on "needs a human" agreed to what, exactly?
 */
export const ANSWER_LABEL: Record<AiVerdict, { agree: string; disagree: string }> = {
  real: { agree: 'Agree it’s real', disagree: 'Disagree: not real' },
  likely_false_positive: {
    agree: 'Agree: likely a false positive',
    disagree: 'Disagree: it’s real',
  },
  needs_human: { agree: 'Agree it needs a person', disagree: 'Disagree' },
};

/** Minutes the person who answered may change it (AI_DECISION_UNDO_MINUTES on the server). */
const UNDO_MINUTES = 15;

/** What the drawer knows about the finding, to say whether a pass can triage it. */
export interface AiFindingContext {
  repoId: number;
  file: string | null;
  line: number | null;
  status: string;
  scannerKey: string | null;
  ruleId: string | null;
  hasContext: boolean;
  experimental: boolean;
}

/**
 * Why an AI pass will never triage this finding, or null when one could
 * (W20-11, UX_TODO AI-83). Mirrors the pass's own selection in
 * apps/api/src/workers/ai-pass-processor.ts (triageStep): open, not shadow,
 * rule-raised, on a file line, with stored code.
 */
export function triageIneligibleReason(f: AiFindingContext): string | null {
  if (f.status !== 'open') return `it is ${f.status.replace(/_/g, ' ')}, not open`;
  if (f.experimental) return 'it comes from a rule still in shadow';
  if (!f.scannerKey || !f.ruleId) return 'it was not raised by a rule';
  if (!f.file || f.line === null)
    return 'it is not tied to a line of a file (a dependency CVE or a repository-level finding)';
  if (!f.hasContext) return 'no code was stored with it when it was scanned';
  return null;
}

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

/**
 * Scrolls the drawer to one of its own sections (W20-16, UX_TODO AI-52). A
 * button, not a #hash link: the drawer lives on a routed page whose URL must
 * not change when someone jumps within it.
 */
function jumpTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  const focusable = el.querySelector<HTMLElement>('pre, button, a, [tabindex]');
  focusable?.focus({ preventScroll: true });
}

const JUMP_LINK =
  'underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** Longest "why" note sent with an answer (the API enforces the same). */
const NOTE_MAX = 500;

function Suggestion({
  findingId,
  s,
  invalidate,
  onOfferDismiss,
  onOfferConfirm,
  evidenceFile,
  seconds = [],
  ask,
}: {
  findingId: number;
  s: AiSuggestion;
  /** W20-18 (UX_TODO AI-14): other models' answers about this suggestion. */
  seconds?: AiSuggestion[];
  /** W20-18 (UX_TODO AI-14): the "ask another model" control, on the newest suggestion. */
  ask?: ReactNode;
  invalidate: readonly (readonly unknown[])[];
  onOfferDismiss: () => void;
  onOfferConfirm?: (() => void) | undefined;
  /** The file the drawer's evidence code is from, so a citation in it can jump there. */
  evidenceFile?: string | null | undefined;
}) {
  const [note, setNote] = useState('');
  const decide = useApiMutation<
    { decision: 'accepted' | 'dismissed'; note?: string } | { undo: true },
    unknown
  >(
    {
      endpoint: '/findings/{id}/ai-verdicts/{verdictId}/decide',
      path: { id: findingId, verdictId: s.id },
      method: 'POST',
    },
    { invalidate },
  );
  const vars = decide.isPending ? decide.variables : undefined;
  const pending = vars && 'decision' in vars ? vars.decision : undefined;
  const open = s.decision === null;
  const labels = ANSWER_LABEL[s.verdict] ?? { agree: 'Agree', disagree: 'Disagree' };

  return (
    <li
      className="flex flex-col gap-2 rounded-sm border border-dashed border-info/50 px-3 py-2"
      data-testid={`ai-suggestion-${s.id}`}
      data-verdict={s.verdict}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <AiBadge />
        <span data-testid="ai-verdict">{VERDICT_SENTENCE[s.verdict]}</span>
        {/* W20-11 (UX_TODO AI-42): the drawer showed two bare "confidence n/5"
            figures, the finding's and the model's; this one says whose. */}
        <span
          className="text-xs text-fg-muted"
          data-testid="ai-confidence"
          title="How sure the model said it was, 1 (a guess) to 5 (certain). A model's own rating, not a measured accuracy."
        >
          AI confidence {s.confidence}/5
        </span>
      </p>
      <p className="text-xs text-fg-faint" data-testid="ai-confidence-scale">
        AI confidence is the model&rsquo;s own rating, 1 (a guess) to 5 (certain), not a measured
        accuracy; it is separate from the finding&rsquo;s confidence above.
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
                {/* W20-16 (UX_TODO AI-52): a citation in the finding's own file
                    jumps to the evidence code shown above. */}
                {evidenceFile === c.file ? (
                  <button
                    type="button"
                    className={`font-mono text-xs text-fg-faint ${JUMP_LINK}`}
                    data-testid="ai-citation-jump"
                    title="Show the evidence code for this file"
                    onClick={() => jumpTo('finding-evidence')}
                  >
                    {c.file}:{c.line}
                  </button>
                ) : (
                  <span className="font-mono text-xs text-fg-faint">
                    {c.file}:{c.line}
                  </span>
                )}
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
          {/* W20-11 (UX_TODO AI-43, partial): the OpenVEX value in words, with
              the raw value kept for whoever records it. */}
          Proposed VEX justification:{' '}
          {VEX_JUSTIFICATION_LABEL[s.vex.justification as VexJustification] ?? s.vex.justification}{' '}
          (<span className="font-mono">{s.vex.justification}</span>)
          {s.vex.statement ? ` — ${s.vex.statement.replace(/[.\s]+$/, '')}` : ''}. Nothing is
          recorded as VEX until a person does it.{' '}
          {/* W20-21 (UX_TODO AI-43): where a person does it, one step away. */}
          <button
            type="button"
            className={JUMP_LINK}
            data-testid="ai-vex-record"
            onClick={() => jumpTo('finding-vex')}
          >
            Record a VEX statement below
          </button>
        </p>
      ) : null}

      <p className="text-xs text-fg-muted" data-testid="ai-patch">
        {s.patch.status === 'verified' && s.patch.diff ? (
          <>
            A patch was proposed and verified by re-scanning. See{' '}
            <button
              type="button"
              className={JUMP_LINK}
              data-testid="ai-jump-verified-fix"
              onClick={() => jumpTo('finding-verified-fix')}
            >
              Verified fix
            </button>
            .
          </>
        ) : s.patch.status === 'not_attempted' || !s.patch.status ? (
          'No patch was proposed or proven for this suggestion.'
        ) : (
          `A proposed patch was not kept (${s.patch.reason ?? s.patch.status}).`
        )}
      </p>

      {seconds.length > 0 || ask ? (
        <div className="flex flex-col gap-1" data-testid="ai-second-opinions">
          {seconds.map((o) => (
            <SecondOpinionAnswer key={o.id} first={s} second={o} />
          ))}
          {ask}
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-decide">
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="ai-agree"
            disabled={decide.isPending}
            aria-busy={pending === 'accepted' || undefined}
            onClick={() =>
              decide.mutate({ decision: 'accepted', ...(note.trim() ? { note: note.trim() } : {}) })
            }
          >
            {pending === 'accepted' ? 'Recording…' : labels.agree}
          </button>
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="ai-disagree"
            disabled={decide.isPending}
            aria-busy={pending === 'dismissed' || undefined}
            onClick={() =>
              decide.mutate({
                decision: 'dismissed',
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            {pending === 'dismissed' ? 'Recording…' : labels.disagree}
          </button>
          <span className="text-xs text-fg-faint">
            Your answer is recorded on the suggestion. It does not change the finding. You can
            change it for {UNDO_MINUTES} minutes.
          </span>
          {/* W20-16 (UX_TODO AI-40): an optional "why", kept with the answer,
              so whoever tunes the rules or the model reads why it was wrong. */}
          <label className="flex w-full flex-col gap-0.5 text-xs text-fg-muted">
            Why (optional, saved with your answer)
            <textarea
              rows={2}
              maxLength={NOTE_MAX}
              className="rounded-sm border border-border bg-surface-2 px-1.5 py-1 text-fg"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="ai-decision-note"
              placeholder="For example: the input is validated two lines above"
            />
          </label>
        </div>
      ) : (
        <div data-testid="ai-decided">
          <p className="text-xs text-fg-muted" role="status">
            {s.decision === 'accepted'
              ? `Answered “${labels.agree}”`
              : s.decision === 'dismissed'
                ? `Answered “${labels.disagree}”`
                : 'Superseded'}
            {s.decided_by ? ` by ${s.decided_by}` : ''}
            {s.decided_at ? ` on ${s.decided_at.slice(0, 10)}` : ''}.
            {s.decision_note ? (
              <span className="block" data-testid="ai-decision-note-shown">
                Why: {s.decision_note}
              </span>
            ) : null}
            {s.can_undo ? (
              <>
                {' '}
                <button
                  type="button"
                  className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid="ai-undo"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ undo: true })}
                >
                  Change my answer
                </button>
              </>
            ) : null}
          </p>
          {/* W20-11 (UX_TODO AI-41): agreeing that a finding is real changed
              nothing and offered nothing; it now points at Confirm. */}
          {s.decision === 'accepted' && s.verdict === 'real' && onOfferConfirm ? (
            <p className="mt-1 text-xs text-fg-muted" data-testid="ai-offer-confirm">
              Agreeing does not confirm the finding: it is still open.{' '}
              <button
                type="button"
                className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="ai-prefill-confirm"
                onClick={onOfferConfirm}
              >
                Confirm it
              </button>{' '}
              (takes you to the note below; you still write it and press Confirm).
            </p>
          ) : null}
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

/**
 * No AI review on this finding (W20-11, UX_TODO AI-44, AI-83). It said "an admin
 * can start one from the Security tab" with no link, also on findings no pass
 * will ever triage, which sent admins to run passes that could not change it.
 */
function NotYetRun({ finding }: { finding: AiFindingContext | undefined }) {
  const why = finding ? triageIneligibleReason(finding) : null;
  if (finding && why) {
    return (
      <p className="mt-1 text-xs text-fg-muted" data-testid="ai-not-eligible">
        No AI review, and an AI pass will not add one: AI triage covers only open, rule-raised
        findings on a line of a file with stored code, and {why}. This says nothing about the
        finding either way.
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-fg-muted" data-testid="ai-not-run">
      Not yet run: no AI review has been recorded for this finding. This says nothing about the
      finding either way.{' '}
      {finding?.file ? (
        <>
          An admin can{' '}
          <Link
            to="/repos/$repoId/ai-review"
            params={{ repoId: String(finding.repoId) } as never}
            search={{ ai_path: finding.file } as never}
            hash="ai-review-pass"
            className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="ai-start-pass-link"
          >
            start an AI review pass on {finding.file}
          </Link>{' '}
          from the repository&rsquo;s Security tab.
        </>
      ) : (
        <>An admin can start one from the repository&rsquo;s Security tab.</>
      )}
    </p>
  );
}

export function AiSuggestions({
  findingId,
  onOfferDismiss,
  onOfferConfirm,
  finding,
}: {
  findingId: number;
  /** Prefills the drawer's own dismiss form; never dismisses. */
  onOfferDismiss: () => void;
  /** Takes the person to the note for Confirm; never confirms. */
  onOfferConfirm?: () => void;
  /** W20-11 (UX_TODO AI-44, AI-83): to say whether a pass can triage it, and link there. */
  finding?: AiFindingContext;
}) {
  const descriptor = { endpoint: '/findings/{id}/ai', path: { id: findingId } } as const;
  const { data, isError } = useApiQuery<FindingAi>(descriptor, {
    // W20-18 (UX_TODO AI-14): follow a second opinion while it runs.
    refetchInterval: (d) =>
      d?.second_opinion?.latest?.status === 'pending' ||
      d?.second_opinion?.latest?.status === 'running'
        ? 4000
        : false,
  });
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const invalidate = [queryKeyFor(descriptor)];

  if (isError) {
    return (
      <p className="text-xs text-fg-faint" data-testid="ai-unavailable">
        AI review information could not be loaded. That says nothing about the finding.
      </p>
    );
  }
  // W20-16 (UX_TODO AI-51): one line while loading, so the drawer does not
  // jump when the section arrives.
  if (!data) {
    return (
      <p className="text-xs text-fg-faint" role="status" data-testid="ai-loading">
        Loading AI review…
      </p>
    );
  }

  // Read defensively: a body of another shape is "nothing recorded", never a crash.
  const raisedBy = data.raised_by ?? null;
  // W20-18 (UX_TODO AI-14): second opinions sit under the suggestion they check.
  const all = data.suggestions ?? [];
  const suggestions = all.filter((s) => !s.second_opinion_of);
  const secondsOf = (id: number) => all.filter((s) => s.second_opinion_of === id);
  const second = data.second_opinion ?? null;
  return (
    <div data-testid="ai-section">
      <h3 className="text-xs tracking-wide text-fg-muted uppercase">AI review</h3>
      {raisedBy ? (
        <p className="mt-1 text-xs text-fg-muted" data-testid="ai-raised-by">
          This finding was raised by an AI specialist ({specialistLabel(raisedBy.specialist)}),{' '}
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
              onOfferConfirm={onOfferConfirm}
              evidenceFile={finding?.file}
              seconds={secondsOf(s.id)}
              ask={
                second && second.of === s.id ? (
                  <AskSecondOpinion
                    findingId={findingId}
                    info={second}
                    isAdmin={me?.role === 'admin'}
                    paused={data.ai_paused}
                    invalidate={invalidate}
                  />
                ) : undefined
              }
            />
          ))}
        </ul>
      ) : !raisedBy ? (
        <NotYetRun finding={finding} />
      ) : (
        <p className="mt-1 text-xs text-fg-muted" data-testid="ai-no-verdict">
          No triage suggestion has been recorded for this finding.
        </p>
      )}
    </div>
  );
}
