import { useEffect, useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import { SEVERITY_LABEL, VERIFY_LABEL, type Finding } from './contracts.js';

// Triage queue (W6-06, R-A8). A full-screen stepper over the current filter.
//
// Fully keyboard operable is the requirement (NFR-5), and it is also the point:
// triaging forty findings with a mouse is a job nobody finishes. j/k move,
// c/d/e act, Esc leaves.

type Decision = 'confirmed' | 'dismissed';

export function TriageQueue({
  findings,
  onExit,
  invalidate,
}: {
  findings: Finding[];
  onExit: () => void;
  invalidate: readonly (readonly unknown[])[];
}) {
  // THE QUEUE YOU STARTED WITH (W16-52).
  //
  // `findings` is the explorer's LIVE list, and each decision invalidates it —
  // so the array shrank under the cursor while the index advanced, and
  // confirming item 1 of 3 landed on item 3. Every decision silently skipped
  // the finding after it, on the screen whose entire purpose is not missing
  // one. It also made the position counter walk backwards ("1 of 3" → "2 of
  // 2"), which is the visible half of the same bug.
  //
  // A stepper works through the set it opened with. Items already decided stay
  // in the run so j/k can go back to them, and the count stays still while
  // someone works.
  const [queue] = useState(findings);
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState('Triaged in queue review.');
  const [done, setDone] = useState<{ confirmed: number; dismissed: number }>({
    confirmed: 0,
    dismissed: 0,
  });
  /**
   * The decision in flight, and the last one refused (W17-23).
   *
   * The counters used to move the instant a key was pressed, before the API
   * had answered — so a 409 (someone else got there first) or a 400 (the note
   * was blanked) still read "1 confirmed" on the way out, and the session
   * summary feeds the false-positive rate. Now a decision counts when the
   * server says it happened, the cursor waits on a refused one so it can be
   * retried, and the refusal is shown against the finding it was for.
   */
  const [inFlight, setInFlight] = useState<{ id: number; status: Decision } | null>(null);
  const [refused, setRefused] = useState<{ id: number; error: unknown } | null>(null);

  const current = queue[index];

  const transition = useApiMutation<
    { status: string; note: string; dismiss_reason?: string },
    unknown
  >(
    {
      endpoint: '/findings/{id}',
      path: { id: current?.id ?? 0 },
      method: 'PATCH',
    },
    { invalidate },
  );

  useEffect(() => {
    function decide(status: Decision) {
      if (!current) return;
      // Only the SAME decision on the SAME finding is held back while it is
      // pending (W17-23) — a second `c` would be a duplicate write. Moving on
      // and deciding the next finding is not, and must not wait.
      if (inFlight?.id === current.id && inFlight.status === status) return;
      const id = current.id;
      const at = index;
      setInFlight({ id, status });
      setRefused((r) => (r?.id === id ? null : r));
      transition.mutate(
        status === 'confirmed'
          ? { status, note }
          : { status, note, dismiss_reason: 'false_positive' },
        {
          onSuccess: () => {
            setDone((d) => ({ ...d, [status]: d[status] + 1 }));
            // Advance only if the cursor is still on the finding decided:
            // someone who pressed j while waiting has already moved.
            setIndex((i) => (i === at ? Math.min(i + 1, queue.length - 1) : i));
          },
          onError: (error) => setRefused({ id, error }),
          onSettled: () => setInFlight((f) => (f?.id === id && f.status === status ? null : f)),
        },
      );
    }
    function onKey(e: KeyboardEvent) {
      // Ignore while typing the note, or every keystroke would triage.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') onExit();
      if (e.key === 'j') setIndex((i) => Math.min(i + 1, queue.length - 1));
      if (e.key === 'k') setIndex((i) => Math.max(i - 1, 0));
      if (e.key === 'c') decide('confirmed');
      if (e.key === 'd') decide('dismissed');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, index, inFlight, queue.length, note, onExit, transition]);

  if (!current) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-8"
        data-testid="triage-queue"
      >
        <div className="text-center">
          <p className="text-lg">Queue empty.</p>
          <button type="button" className="mt-2 text-sm text-accent underline" onClick={onExit}>
            Back to the explorer
          </button>
        </div>
      </div>
    );
  }

  const pendingHere = inFlight?.id === current.id ? inFlight.status : null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col gap-4 overflow-auto bg-bg/95 p-8 backdrop-blur"
      data-testid="triage-queue"
      role="dialog"
      aria-modal="true"
      aria-label="Findings triage queue"
    >
      <div className="flex items-baseline gap-3">
        <h2 className="flex-1 text-lg font-semibold">{current.title}</h2>
        <span className="text-xs text-fg-muted" data-testid="triage-position">
          {index + 1} of {queue.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
        <span>{SEVERITY_LABEL[current.severity]}</span>
        <span>{current.dimension.replace('_', ' ')}</span>
        <span>{VERIFY_LABEL[current.verify_status]}</span>
        <span className="font-mono">
          {current.file}:{current.line_range[0]}
        </span>
        {/* The server's status, never the key just pressed (W17-23). */}
        <span data-testid="triage-status">status {current.status.replace('_', ' ')}</span>
      </div>

      {/* Evidence inline — the whole reason a stepper beats a list: the thing
          you need in order to decide is already on screen. */}
      <pre className="overflow-x-auto panel-inset p-3 font-mono text-xs whitespace-pre-wrap">
        {current.evidence}
      </pre>
      <p className="text-sm">{current.recommendation}</p>

      <label className="flex max-w-lg flex-col gap-1 text-xs text-fg-muted">
        Note applied to each decision
        <input
          className="panel px-2 py-1 text-sm"
          data-testid="triage-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <kbd className="rounded border border-border px-1">j</kbd> next
        <kbd className="rounded border border-border px-1">k</kbd> previous
        <kbd className="rounded border border-border px-1">c</kbd> confirm
        <kbd className="rounded border border-border px-1">d</kbd> dismiss as false positive
        <kbd className="rounded border border-border px-1">esc</kbd> exit
      </div>

      {pendingHere && (
        <p className="text-xs text-fg-muted" data-testid="triage-pending" aria-live="polite">
          {pendingHere === 'confirmed' ? 'Confirming…' : 'Dismissing…'}
        </p>
      )}
      {refused?.id === current.id && <ErrorNote error={refused.error} testId="triage-error" />}

      {/* The exit summary carries the false-positive count, which is the same
          number the analysis-quality widget reads — triage is where that metric
          actually comes from. */}
      <p className="text-xs text-fg-faint" data-testid="triage-summary">
        {done.confirmed} confirmed · {done.dismissed} dismissed as false positive this session
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          data-testid="triage-exit"
          onClick={onExit}
        >
          Exit queue
        </button>
      </div>
    </div>
  );
}
