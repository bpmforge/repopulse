import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import { DISMISS_NOTE_MIN, type Finding } from './contracts.js';

// Proving a finding is gone (W20-21, UX_TODO FND-51, FND-61).
//
// Two ways a person shows a finding is dealt with, beside the lifecycle
// buttons: a leaked secret is recorded as rotated (the secrets scan never
// sweeps, so deleting the line closes nothing — the secret stays in git
// history), and any scanner finding can be re-checked by re-running the
// scanner that raised it.

const BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** "Record as rotated" for a secret finding (FND-61). */
export function SecretRotated({
  finding,
  invalidate,
}: {
  finding: Pick<Finding, 'id' | 'status' | 'dismiss_reason'>;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [open, setOpen] = useState(false);
  const [rotatedOn, setRotatedOn] = useState(today());
  const [note, setNote] = useState('');
  const record = useApiMutation<{ rotated_on: string; note: string }, unknown>(
    { endpoint: '/findings/{id}/rotated', path: { id: finding.id }, method: 'POST' },
    { invalidate },
  );
  const active = finding.status === 'open' || finding.status === 'confirmed';

  if (finding.dismiss_reason === 'rotated' && finding.status === 'resolved') {
    return (
      <p className="text-xs text-fg-muted" data-testid="secret-rotated-done">
        Recorded as rotated. A rotated secret stays closed even when a later scan sees it again in
        the history.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="secret-rotated">
      <p className="text-fg-muted">
        Removing the line does not close this finding: the secret stays in the repository&apos;s
        history, and it is only safe once the credential is rotated at the issuer.
        {active ? ' Record the rotation here once it is done.' : ''}
      </p>
      {active && !open && (
        <button
          type="button"
          className={`${BUTTON} self-start`}
          data-testid="secret-rotated-open"
          onClick={() => setOpen(true)}
        >
          Record as rotated
        </button>
      )}
      {active && open && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            record.mutate(
              { rotated_on: rotatedOn, note: note.trim() },
              { onSuccess: () => setOpen(false) },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-fg-muted">
            Rotated on
            <input
              type="date"
              className="panel px-2 py-1 text-sm"
              data-testid="secret-rotated-on"
              max={today()}
              value={rotatedOn}
              required
              onChange={(e) => setRotatedOn(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-fg-muted">
            What was done (at least {DISMISS_NOTE_MIN} characters)
            <input
              className="panel w-72 px-2 py-1 text-sm"
              data-testid="secret-rotated-note"
              placeholder="Revoked the key at the issuer and issued a new one"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className={BUTTON}
            data-testid="secret-rotated-submit"
            disabled={record.isPending || note.trim().length < DISMISS_NOTE_MIN || !rotatedOn}
          >
            {record.isPending ? 'Recording…' : 'Record and close'}
          </button>
          <button
            type="button"
            className="text-fg-muted underline underline-offset-2"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </form>
      )}
      <ErrorNote error={record.error} testId="secret-rotated-error" />
    </div>
  );
}

/** "Re-scan to verify": re-run the scanner that raised this finding (FND-51). Admin only. */
export function RescanToVerify({ repoId, scannerKey }: { repoId: number; scannerKey: string }) {
  const run = useApiMutation<
    { scanner_key: string },
    { started: string[]; already_running: string[] }
  >({ endpoint: '/repos/{id}/scan', path: { id: repoId }, method: 'POST' });
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        className={BUTTON}
        data-testid="finding-rescan"
        disabled={run.isPending}
        title="Runs this finding's scanner over the repository again. A finding it no longer sees is resolved, and the history names the scan."
        onClick={() => run.mutate({ scanner_key: scannerKey })}
      >
        {run.isPending ? 'Starting…' : 'Re-scan to verify'}
      </button>
      {run.isSuccess && (
        <span role="status" className="text-fg-muted" data-testid="finding-rescan-status">
          {run.data.started.length > 0
            ? 'Started. The history here says when the scan no longer sees it.'
            : 'That scanner is already running.'}
        </span>
      )}
      <ErrorNote error={run.error} testId="finding-rescan-error" />
    </span>
  );
}
