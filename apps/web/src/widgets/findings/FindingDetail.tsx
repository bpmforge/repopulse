import { useState } from 'react';
import { WidgetFrame } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { locationOf, SEVERITY_LABEL, type Finding, type FindingEvent } from './contracts.js';

// Finding detail panel (W6-04, UX_SPEC §4.e).

const DISMISS_REASONS = ['false_positive', 'accepted_risk', 'not_applicable', 'duplicate'] as const;

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

  const historyDescriptor = {
    endpoint: '/findings/{id}/history',
    path: { id: finding.id },
  } as const;
  const { data: history } = useApiQuery<{ items: FindingEvent[] }>(historyDescriptor);

  const transition = useApiMutation<{ status: string; note: string; dismiss_reason?: string }, unknown>(
    { endpoint: '/findings/{id}', path: { id: finding.id }, method: 'PATCH' },
    // The panel's OWN history query is invalidated too. Without it the audit
    // trail the user just added to keeps showing the previous state — the
    // change looks like it did not happen.
    { invalidate: [...invalidate, queryKeyFor(historyDescriptor)] },
  );

  return (
    <WidgetFrame title={finding.title} state="ready">
      <div className="flex flex-col gap-3" data-testid="finding-detail">
        <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
          <span>{SEVERITY_LABEL[finding.severity]}</span>
          <span>confidence {finding.confidence}/5</span>
          <span>{finding.dimension.replace('_', ' ')}</span>
          <span>seen {finding.occurrence_count}×</span>
          <span>Tier {finding.tier}</span>
        </div>

        {/* The quote is why anyone should believe the finding — it is validated
            to be verbatim from the reviewed diff (W6-02), so it can be read as
            evidence rather than as the model's paraphrase. */}
        <div>
          <h3 className="text-xs tracking-wide text-fg-muted uppercase">Evidence</h3>
          <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">
            {finding.evidence}
          </pre>
          <p className="mt-1 font-mono text-xs text-fg-faint">
            {locationOf(finding)}
          </p>
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
                <span className="text-fg-muted">{e.at.slice(0, 10)}</span> {e.from_status ?? 'new'} →{' '}
                {e.to_status}{' '}
                {/* Automatic transitions are labelled: an analysis pass
                    reopening a finding must not look like a colleague doing it. */}
                <span className="text-fg-faint">
                  ({e.automatic ? 'automatic' : 'by a person'}
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
              className="w-72 rounded-md border border-border bg-surface px-2 py-1 text-sm"
              data-testid="finding-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Dismiss reason
            <select
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
            className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="finding-confirm"
            disabled={transition.isPending || note.trim() === ''}
            onClick={() => transition.mutate({ status: 'confirmed', note })}
          >
            Confirm
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="finding-dismiss"
            disabled={transition.isPending || note.trim() === ''}
            onClick={() => transition.mutate({ status: 'dismissed', note, dismiss_reason: reason })}
          >
            Dismiss
          </button>
          <button type="button" className="text-xs text-fg-muted underline underline-offset-2" onClick={onClose}>
            Close
          </button>
        </div>
        {/* The note is required by the API too — a dismissal with no reason is
            unreviewable six months later, which is exactly when it matters. */}
        {note.trim() === '' && (
          <p className="text-xs text-fg-faint">A note is required before changing status.</p>
        )}
      </div>
    </WidgetFrame>
  );
}
