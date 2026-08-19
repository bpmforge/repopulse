import { useEffect, useState } from 'react';
import { useApiMutation } from '../../api/useApiQuery.js';
import { SEVERITY_LABEL, VERIFY_LABEL, type Finding } from './contracts.js';

// Triage queue (W6-06, R-A8). A full-screen stepper over the current filter.
//
// Fully keyboard operable is the requirement (NFR-5), and it is also the point:
// triaging forty findings with a mouse is a job nobody finishes. j/k move,
// c/d/e act, Esc leaves.

export function TriageQueue({
  findings,
  onExit,
  invalidate,
}: {
  findings: Finding[];
  onExit: () => void;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState('Triaged in queue review.');
  const [done, setDone] = useState<{ confirmed: number; dismissed: number }>({
    confirmed: 0,
    dismissed: 0,
  });

  const current = findings[index];

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
    function onKey(e: KeyboardEvent) {
      // Ignore while typing the note, or every keystroke would triage.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') onExit();
      if (e.key === 'j') setIndex((i) => Math.min(i + 1, findings.length - 1));
      if (e.key === 'k') setIndex((i) => Math.max(i - 1, 0));
      if (!current) return;
      if (e.key === 'c') {
        transition.mutate({ status: 'confirmed', note });
        setDone((d) => ({ ...d, confirmed: d.confirmed + 1 }));
        setIndex((i) => Math.min(i + 1, findings.length - 1));
      }
      if (e.key === 'd') {
        transition.mutate({ status: 'dismissed', note, dismiss_reason: 'false_positive' });
        setDone((d) => ({ ...d, dismissed: d.dismissed + 1 }));
        setIndex((i) => Math.min(i + 1, findings.length - 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, findings.length, note, onExit, transition]);

  if (!current) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-8" data-testid="triage-queue">
        <div className="text-center">
          <p className="text-lg">Queue empty.</p>
          <button type="button" className="mt-2 text-sm text-accent underline" onClick={onExit}>
            Back to the explorer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col gap-4 overflow-auto bg-bg/95 p-8"
      data-testid="triage-queue"
      role="dialog"
      aria-modal="true"
      aria-label="Findings triage queue"
    >
      <div className="flex items-baseline gap-3">
        <h2 className="flex-1 text-lg font-semibold">{current.title}</h2>
        <span className="text-xs text-fg-muted" data-testid="triage-position">
          {index + 1} of {findings.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
        <span>{SEVERITY_LABEL[current.severity]}</span>
        <span>{current.dimension.replace('_', ' ')}</span>
        <span>{VERIFY_LABEL[current.verify_status]}</span>
        <span className="font-mono">
          {current.file}:{current.line_range[0]}
        </span>
      </div>

      {/* Evidence inline — the whole reason a stepper beats a list: the thing
          you need in order to decide is already on screen. */}
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">
        {current.evidence}
      </pre>
      <p className="text-sm">{current.recommendation}</p>

      <label className="flex max-w-lg flex-col gap-1 text-xs text-fg-muted">
        Note applied to each decision
        <input
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
