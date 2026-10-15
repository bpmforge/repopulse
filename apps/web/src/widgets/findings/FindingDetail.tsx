import { useState } from 'react';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import {
  locationOf,
  reviewSummary,
  SEVERITY_LABEL,
  type Finding,
  type FindingEvent,
} from './contracts.js';
import { EvidenceCode } from './EvidenceCode.js';
import { PlanForRepoLink } from '../plans/PlanForRepoLink.js';

// Finding detail panel (W6-04, UX_SPEC §4.e).

const DISMISS_REASONS = ['false_positive', 'accepted_risk', 'not_applicable', 'duplicate'] as const;

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
        </div>

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
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
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
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="finding-confirm"
            disabled={pending === 'confirmed' || note.trim() === ''}
            aria-busy={pending === 'confirmed' || undefined}
            onClick={() => transition.mutate({ status: 'confirmed', note })}
          >
            {pending === 'confirmed' ? 'Confirming…' : 'Confirm'}
          </button>
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="finding-dismiss"
            disabled={pending === 'dismissed' || note.trim() === ''}
            aria-busy={pending === 'dismissed' || undefined}
            onClick={() => transition.mutate({ status: 'dismissed', note, dismiss_reason: reason })}
          >
            {pending === 'dismissed' ? 'Dismissing…' : 'Dismiss'}
          </button>
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
        {/* The note is required by the API too — a dismissal with no reason is
            unreviewable six months later, which is exactly when it matters. */}
        {note.trim() === '' && (
          <p className="text-xs text-fg-faint">A note is required before changing status.</p>
        )}
      </div>
    </WidgetFrame>
  );
}
