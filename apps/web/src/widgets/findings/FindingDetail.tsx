import { useRef, useState } from 'react';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import {
  allowedFindingTransitions,
  autoCloseNote,
  DISMISS_NOTE_MIN,
  DISMISS_REASONS,
  FINDING_ACTIONS,
  FINDING_DONE_LABEL,
  locationOf,
  reviewSummary,
  SEVERITY_LABEL,
  undoTargetFor,
  type Finding,
  type FindingEvent,
  type FindingLifecycleStatus,
} from './contracts.js';
import { EvidenceCode } from './EvidenceCode.js';
import { PlanForRepoLink } from '../plans/PlanForRepoLink.js';
import { VerifiedFix } from './VerifiedFix.js';
import { AiSuggestions } from './AiSuggestions.js';
import { RulePrecisionSummary } from '../trust/RulePrecision.js';
import { SHADOW_EXPLAINER, ShadowBadge } from './ShadowBadge.js';
import { DependencyWhy } from './DependencyWhy.js';
import { VexForm } from './VexForm.js';
import { ProposeRuleForm } from '../rules/ProposeRuleForm.js';

/** Moves that close a finding without a fix (W20-08, UX_TODO FND-66). */
const CLOSING: readonly string[] = ['dismissed', 'wont_fix'];

// Finding detail panel (W6-04, UX_SPEC §4.e).

const ACTION_BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function FindingDetail({
  finding,
  onClose,
  invalidate,
}: {
  finding: Finding;
  onClose: () => void;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<string>('false_positive');
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const noteRef = useRef<HTMLInputElement>(null);
  const [proposing, setProposing] = useState(false);
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
  /**
   * W20-08 (UX_TODO FND-66): a high or critical finding, or one raised on a
   * pull request still open, is dismissed or marked won't fix by an admin
   * only (SRS FR-AUTH-4 has two roles), and every such note says why in at
   * least ten characters. The API enforces both; the buttons say so first.
   */
  const closingLocked = finding.dismiss_requires_admin === true && !isAdmin;
  const noteTooShort = note.trim().length < DISMISS_NOTE_MIN;
  /**
   * The last change made from this panel, for the status message and its Undo
   * (W20-03, UX_TODO FND-02). Held with the finding's id because the explorer
   * re-renders this same panel for the next finding: a message about #7 must
   * not appear under #8.
   */
  const [lastChange, setLastChange] = useState<{
    findingId: number;
    from: string;
    to: FindingLifecycleStatus;
    fromReason: string | null;
    undone: boolean;
  } | null>(null);

  const historyDescriptor = {
    endpoint: '/findings/{id}/history',
    path: { id: finding.id },
  } as const;
  const { data: history } = useApiQuery<{ items: FindingEvent[] }>(historyDescriptor);

  const transition = useApiMutation<
    { status: string; note: string; dismiss_reason?: string },
    unknown
  >(
    { endpoint: '/findings/{id}', path: { id: finding.id }, method: 'PATCH' },
    // The panel's OWN history query is invalidated too. Without it the audit
    // trail the user just added to keeps showing the previous state — the
    // change looks like it did not happen.
    { invalidate: [...invalidate, queryKeyFor(historyDescriptor)] },
  );

  /**
   * Which action is in flight, if any (W17-23). Only THAT control is disabled:
   * `isPending` alone greyed out both Confirm and Dismiss, so a slow confirm
   * read as "the panel is broken" rather than "one request is running". The
   * status shown is never taken from the request — it is `finding.status`,
   * re-read from the API once the mutation invalidates the list, so a failed
   * write leaves the chip exactly where the database has it.
   */
  const pending = transition.isPending ? transition.variables?.status : undefined;
  const allowed = allowedFindingTransitions(finding.status);

  const change = lastChange?.findingId === finding.id ? lastChange : null;
  /** PATCH back to where the finding was, with a note that says why (FND-02). */
  const undo = () => {
    if (!change) return;
    const target = undoTargetFor(change.from, change.to);
    if (!target) return;
    const undoNote = `Undo of ${FINDING_ACTIONS[change.to].label}`;
    transition.mutate(
      target === 'dismissed'
        ? {
            status: target,
            note: undoNote,
            // Back to the reason it had, not a default: an undo that quietly
            // turned "duplicate" into "false positive" would move the FP rate.
            ...(change.fromReason ? { dismiss_reason: change.fromReason } : {}),
          }
        : { status: target, note: undoNote },
      { onSuccess: () => setLastChange({ ...change, undone: true }) },
    );
  };

  const copySummary = () => {
    const text = reviewSummary(finding, history?.items ?? []);
    // Clipboard access can be refused (insecure origin, denied permission).
    // The button then says so rather than claiming success — and nothing
    // else happens either way: no request leaves the browser for this.
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopied('failed');
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => setCopied('copied'))
      .catch(() => setCopied('failed'));
  };

  return (
    <WidgetFrame title={finding.title} state="ready">
      {/* Escape closes, from anywhere inside the panel (W17-22). On the element
          rather than window so it cannot collide with the triage queue's own
          Escape, and the note field is not exempt: Escape is not a keystroke a
          note needs. */}
      <div
        className="flex flex-col gap-3"
        data-testid="finding-detail"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
          <span>{SEVERITY_LABEL[finding.severity]}</span>
          <span>confidence {finding.confidence}/5</span>
          <span>{finding.dimension.replace('_', ' ')}</span>
          <span>seen {finding.occurrence_count}×</span>
          <span>Tier {finding.tier}</span>
          {/* The status, from the server's copy of the finding — never from
              the button that was just pressed (W17-23). */}
          <span data-testid="finding-status">status {finding.status.replace('_', ' ')}</span>
          {finding.rule_id ? (
            <span className="font-mono" data-testid="finding-rule">
              rule {finding.rule_id}
            </span>
          ) : null}
        </div>

        {/* W18-29: said in the panel, not only as a chip in the list — the
            panel is what a shared link opens, with no list around it. */}
        {finding.experimental ? (
          <p
            className="flex flex-wrap items-center gap-2 rounded-sm border border-dashed border-fg-faint px-3 py-2 text-xs text-fg-muted"
            data-testid="finding-shadow-note"
            role="note"
          >
            <ShadowBadge />
            <span>{SHADOW_EXPLAINER}</span>
          </p>
        ) : null}

        {/* The quote is why anyone should believe the finding — it is validated
            to be verbatim from the reviewed diff (W6-02), so it can be read as
            evidence rather than as the model's paraphrase. */}
        <div>
          <h3 className="text-xs tracking-wide text-fg-muted uppercase">Evidence</h3>
          <div className="mt-1">
            <EvidenceCode finding={finding} />
          </div>
          <p className="mt-1 font-mono text-xs text-fg-faint">
            {/* THE LOCATION IS NOW A LINK (W16-41). It was plain text, so on a
                triage tool whose whole workflow is "look at this one", the step
                after reading a finding was to go and find the file by hand.
                Still plain text when there is nothing honest to link to. */}
            {finding.forge ? (
              <a
                href={finding.forge.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="finding-forge-link"
              >
                {locationOf(finding)}
              </a>
            ) : (
              locationOf(finding)
            )}
          </p>
          {finding.forge?.ref_kind === 'branch' && (
            // The link is only as precise as the ref behind it. Without the
            // scan's commit it opens the default branch, where line 15 may no
            // longer be the line this finding is about — worth one sentence
            // rather than a link that silently means something else.
            <p className="mt-1 text-xs text-fg-faint" data-testid="finding-forge-ref-note">
              Opens the default branch — this finding records no commit, so the lines may have moved
              since it was raised.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-xs tracking-wide text-fg-muted uppercase">Recommendation</h3>
          <p className="mt-1 text-sm">{finding.recommendation}</p>
        </div>

        {/* W20-08 (UX_TODO FND-57): what the scanner worked out, so "real, or
            not affected?" can be answered from this panel. */}
        <DependencyWhy finding={finding} />

        {/* W20-08 (UX_TODO FND-05): a person records the VEX statement here. */}
        {finding.dimension === 'dependency' && (finding.cve_id || finding.rule_id) && (
          <VexForm finding={finding} invalidate={invalidate} />
        )}

        {/* W18-19: a model-drafted patch, shown only once the re-scan proved it
            clears this finding without raising another (D16). Copy and
            download; never a write to the forge (D9a). */}
        <VerifiedFix findingId={finding.id} />

        {/* W19-10: what an AI pass said about this finding, labelled as AI. It
            only PREFILLS the dismiss form below; the person still writes the note
            and presses Dismiss (D9a). */}
        <AiSuggestions
          findingId={finding.id}
          onOfferDismiss={() => {
            setReason('false_positive');
            noteRef.current?.focus();
          }}
          onOfferConfirm={() => noteRef.current?.focus()}
          finding={{
            repoId: finding.repo.id,
            file: finding.file,
            line: finding.line_range[0],
            status: finding.status,
            scannerKey: finding.scanner_key ?? null,
            ruleId: finding.rule_id ?? null,
            // Absent (not null) means not sent: unknown, so not held against it.
            hasContext: finding.context !== null,
            experimental: finding.experimental === true,
          }}
        />

        {/* W18-22: how far this rule has been shown to be right, before
            anyone acts on what it says. */}
        {finding.rule_id && <RulePrecisionSummary ruleId={finding.rule_id} />}

        <div>
          <h3 className="text-xs tracking-wide text-fg-muted uppercase">History</h3>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs" data-testid="finding-history">
            {(history?.items ?? []).map((e, i) => (
              <li key={i}>
                <span className="text-fg-muted">{e.at.slice(0, 10)}</span> {e.from_status ?? 'new'}{' '}
                → {e.to_status}{' '}
                {/* THREE STATES (W16-59). An analysis pass reopening a finding
                    must not look like a colleague doing it — and now that a
                    removed account nulls the actor id, a departed colleague
                    must not look automatic either. The login kept beside the id
                    is what separates them, and a name outlives the account. */}
                <span className="text-fg-faint">
                  ({e.automatic ? 'automatic' : (e.actor_login ?? 'by a person')}
                  {e.reason ? `: ${e.reason}` : ''})
                </span>
              </li>
            ))}
            {(history?.items ?? []).length === 0 && (
              <li className="text-fg-muted">No status changes yet.</li>
            )}
          </ul>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Note (required)
            <input
              className="w-72 panel px-2 py-1 text-sm"
              data-testid="finding-note"
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {/* W20-01 (UX_TODO FND-01): only Confirm and Dismiss existed, both
              always enabled, so "mark fixed", "won't fix" and any reopen could
              not be done from the UI and a dismissed finding answered both
              buttons with a 409. The buttons are now the transitions the
              lifecycle allows from THIS status, and nothing else. */}
          {allowed.includes('dismissed') && (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Dismiss reason
              <select
                className="panel px-2 py-1 text-sm"
                data-testid="finding-dismiss-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                {DISMISS_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {allowed.map((to) => {
            const action = FINDING_ACTIONS[to];
            const closing = CLOSING.includes(to);
            const locked = closing && closingLocked;
            return (
              <button
                key={to}
                type="button"
                className={ACTION_BUTTON}
                data-testid={action.testId}
                title={
                  locked
                    ? `${action.hint} Only an admin may do this for a high or critical finding, or one on a pull request that is still open.`
                    : action.hint
                }
                disabled={
                  pending === to || note.trim() === '' || locked || (closing && noteTooShort)
                }
                aria-busy={pending === to || undefined}
                onClick={() => {
                  const from = finding.status;
                  const fromReason = finding.dismiss_reason;
                  transition.mutate(
                    to === 'dismissed'
                      ? { status: to, note, dismiss_reason: reason }
                      : { status: to, note },
                    {
                      onSuccess: () => {
                        setNote('');
                        setLastChange({
                          findingId: finding.id,
                          from,
                          to,
                          fromReason,
                          undone: false,
                        });
                      },
                    },
                  );
                }}
              >
                {pending === to ? action.busy : action.label}
              </button>
            );
          })}
          {/* Plain text to the clipboard, nothing to the forge (W17-23). A
              review is acted on in a PR thread or a ticket, and this is the
              way there that does not require RepoPulse to write to either. */}
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="finding-copy-summary"
            onClick={copySummary}
          >
            {copied === 'copied'
              ? 'Copied'
              : copied === 'failed'
                ? 'Copy failed — select the text instead'
                : 'Copy review summary'}
          </button>
          {/* To the plan for this finding's repository (W17-24): a link that
              carries the id, and only navigates. */}
          <PlanForRepoLink repoId={finding.repo.id} />
          {/* W20-08 (UX_TODO FND-65): an admin turns a finding pattern into a
              rule proposal; it lands proposed and runs nowhere until accepted. */}
          {isAdmin && !proposing && (
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="finding-propose-rule"
              onClick={() => setProposing(true)}
            >
              Propose a rule from this finding
            </button>
          )}
          <button
            type="button"
            className="text-xs text-fg-muted underline underline-offset-2"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {/* A refused write says so where the button is (W17-23). Before this a
            409 — someone else triaged it first, or the row is in a state this
            action cannot leave — vanished, and the panel simply did nothing. */}
        <ErrorNote error={transition.error} testId="finding-action-error" />
        {change && <ChangeMessage change={change} pending={pending} onUndo={undo} />}
        {/* The note is required by the API too — a dismissal with no reason is
            unreviewable six months later, which is exactly when it matters. */}
        {note.trim() === '' && (
          <p className="text-xs text-fg-faint">A note is required before changing status.</p>
        )}
        {allowed.some((to) => CLOSING.includes(to)) && (
          <p className="text-xs text-fg-faint" data-testid="finding-dismiss-rule">
            {closingLocked
              ? "Dismiss and Won't fix: admins only for this finding (high or critical, or raised on a pull request that is still open). Ask an admin, or Confirm it."
              : `Dismiss and Won't fix need a note of at least ${DISMISS_NOTE_MIN} characters${
                  finding.dismiss_requires_admin ? ', and an admin for this finding' : ''
                }.`}
          </p>
        )}
        {/* W20-08 (UX_TODO FND-58): whether waiting for a re-scan will close it. */}
        {(finding.status === 'open' || finding.status === 'confirmed') && (
          <p className="text-xs text-fg-faint" data-testid="finding-auto-close">
            {autoCloseNote(finding)}
          </p>
        )}
        {proposing && (
          <ProposeRuleForm
            seed={{
              id: finding.id,
              title: finding.title,
              dimension: finding.dimension,
              severity: finding.severity,
              file: finding.file,
              evidence: finding.evidence,
              rule_id: finding.rule_id ?? null,
              context: finding.context ?? null,
            }}
            onClose={() => setProposing(false)}
          />
        )}
      </div>
    </WidgetFrame>
  );
}

/**
 * What the last change did, and how to take it back (W20-03, UX_TODO FND-02).
 *
 * A mis-click on Dismiss used to be reversible only through the API. Undo is
 * offered when the lifecycle has a way back; when it has none (nothing goes
 * from confirmed back to open) the message says so and names what CAN be done,
 * rather than offering a button the API would refuse.
 */
function ChangeMessage({
  change,
  pending,
  onUndo,
}: {
  change: { from: string; to: FindingLifecycleStatus; undone: boolean };
  pending: string | undefined;
  onUndo: () => void;
}) {
  const target = undoTargetFor(change.from, change.to);
  const fromLabel = change.from.replace('_', ' ');
  return (
    <p className="text-xs" data-testid="finding-change-status" role="status">
      {change.undone ? (
        `Undone: the finding is ${fromLabel} again.`
      ) : (
        <>
          {FINDING_DONE_LABEL[change.to]}.{' '}
          {target ? (
            <button
              type="button"
              className="text-accent underline underline-offset-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="finding-undo"
              disabled={pending === target}
              onClick={onUndo}
            >
              {pending === target ? 'Undoing…' : 'Undo'}
            </button>
          ) : (
            <span className="text-fg-muted" data-testid="finding-no-undo">
              This cannot be undone: the lifecycle has no way from {change.to.replace('_', ' ')}{' '}
              back to {fromLabel}. If it was a mistake, use{' '}
              {allowedFindingTransitions(change.to)
                .map((t) => FINDING_ACTIONS[t].label)
                .join(' or ')}{' '}
              instead.
            </span>
          )}
        </>
      )}
    </p>
  );
}
