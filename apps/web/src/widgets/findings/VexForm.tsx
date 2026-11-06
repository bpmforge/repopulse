import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import { VEX_JUSTIFICATIONS, VEX_STATUSES, type Finding } from './contracts.js';

// Record a VEX statement from the finding panel (W20-08, UX_TODO FND-05).
//
// The funnel counted statements, the AI drawer said "nothing is recorded as
// VEX until a person does it", and the only way to record one was the API. A
// person does it here: status, the OpenVEX justification (required for "not
// affected", as SRS FR-SEC-14 and the API both say), an optional version range
// and a note. Nothing is prefilled from an AI suggestion — the person picks.

const FIELD = 'panel px-2 py-1 text-sm';

export function VexForm({
  finding,
  invalidate,
}: {
  finding: Finding;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>('not_affected');
  const [justification, setJustification] = useState('');
  const [range, setRange] = useState('');
  const [notes, setNotes] = useState('');
  const record = useApiMutation<
    { status: string; justification?: string; version_range?: string; notes?: string },
    { id: number; version_range: string; status: string }
  >(
    { endpoint: '/findings/{id}/vex', path: { id: finding.id }, method: 'POST' },
    {
      invalidate: [...invalidate, ['/repos/{id}/security', { id: String(finding.repo.id) }, {}]],
    },
  );

  const needsJustification = status === 'not_affected';
  const ready = !needsJustification || justification !== '';

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="vex-closed">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="vex-open"
          onClick={() => setOpen(true)}
        >
          Record VEX statement
        </button>
        <span className="text-fg-muted">
          Say whether this vulnerability affects this repository, with the reason, so the next scan
          and the VEX export carry it.
        </span>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs"
      data-testid="vex-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        record.mutate({
          status,
          ...(justification && status === 'not_affected' ? { justification } : {}),
          ...(range.trim() ? { version_range: range.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
      }}
    >
      <h3 className="section-label">VEX statement</h3>
      <label className="flex flex-col gap-1 text-fg-muted">
        Status
        <select
          className={FIELD}
          data-testid="vex-status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {VEX_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {needsJustification && (
        <label className="flex flex-col gap-1 text-fg-muted">
          Justification (required)
          <select
            className={FIELD}
            data-testid="vex-justification"
            value={justification}
            required
            onChange={(e) => setJustification(e.target.value)}
          >
            <option value="">Choose why it does not apply…</option>
            {VEX_JUSTIFICATIONS.map((j) => (
              <option key={j.value} value={j.value}>
                {j.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-fg-muted">
        Version range (optional)
        <input
          className={FIELD}
          data-testid="vex-range"
          placeholder="Defaults to the version this finding is about, e.g. >=1.2.0 <1.3.0"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-fg-muted">
        Note
        <input
          className={FIELD}
          data-testid="vex-notes"
          placeholder="What you checked"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="rounded-md btn-primary px-2 py-1 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="vex-submit"
          disabled={!ready || record.isPending}
          aria-busy={record.isPending || undefined}
        >
          {record.isPending ? 'Recording…' : 'Record statement'}
        </button>
        <button
          type="button"
          className="text-fg-muted underline underline-offset-2"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {!ready && (
        <p className="text-fg-faint" data-testid="vex-needs-justification">
          &quot;Not affected&quot; needs a justification, so a reader can disagree with the reason.
        </p>
      )}
      <ErrorNote error={record.error} testId="vex-error" />
      {record.isSuccess && (
        <p role="status" data-testid="vex-recorded">
          Recorded: {record.data.status.replace('_', ' ')} for {record.data.version_range}. The next
          dependency scan reads it, and it is in the VEX export.
        </p>
      )}
    </form>
  );
}
