import { useEffect, useRef, useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import { EvidenceCode } from './EvidenceCode.js';
import { ShadowBadge } from './ShadowBadge.js';
import { trapTab } from './focusTrap.js';
import {
  DISMISS_REASON_LABEL,
  DISMISS_REASONS,
  SEVERITY_LABEL,
  verifyLabelOf,
  dimensionLabel,
  isDismissReason,
  locationOf,
  statusLabel,
  type DismissReason,
  type Finding,
} from './contracts.js';

// Triage queue (W6-06, R-A8). A full-screen stepper over the current filter.
//
// Fully keyboard operable is the requirement (NFR-5), and it is also the point:
// triaging forty findings with a mouse is a job nobody finishes. j/k move,
// c/d act (1–4 pick the dismiss reason), Esc leaves. W20-13 (FND-44): the
// comment promised an `e` key that never existed.
//
// W20-13 (FND-34): single-letter keys with no modifier collide with screen
// reader quick keys (WCAG 2.1.4), so they can be switched off from the queue
// itself; focus starts on the heading and Tab stays inside the dialog.
//
// W20-03 (UX_TODO FND-08/09/10): the note started prefilled with boilerplate
// and `d` always dismissed as false_positive, so every queue decision carried
// the same note and fed the false-positive rate whatever the real reason was.
// The note now starts empty and must be written, a dismissal needs a reason
// (picker, or keys 1–4), every key has a visible button for touch screens, and
// the end of the page says so and offers the next one.

type Decision = 'confirmed' | 'dismissed';

const SHORTCUTS_KEY = 'repopulse.triage.shortcuts';

function readShortcutsPref(): boolean {
  try {
    return window.localStorage.getItem(SHORTCUTS_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeShortcutsPref(on: boolean): void {
  try {
    window.localStorage.setItem(SHORTCUTS_KEY, on ? 'on' : 'off');
  } catch {
    // A blocked store only means the choice is not remembered.
  }
}

const BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function TriageQueue({
  findings,
  onExit,
  invalidate,
  nextCursor = null,
  onNextPage,
}: {
  findings: Finding[];
  onExit: () => void;
  invalidate: readonly (readonly unknown[])[];
  /**
   * Where the list goes after this page, as it was when the queue opened
   * (W20-03, FND-10). Taken at open rather than read live: with the default
   * `status=open` filter every decision drops a row out of page one, and the
   * live cursor would then skip the findings that slid up into it.
   */
  nextCursor?: string | null;
  onNextPage?: (cursor: string) => void;
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
  const [next] = useState(nextCursor);
  const [index, setIndex] = useState(0);
  // Empty, and required (FND-08): a note is the record of why, and one typed
  // for the reviewer by the screen records nothing.
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<DismissReason | ''>('');
  const [hint, setHint] = useState<string | null>(null);
  /** Past the last finding: the end-of-page summary shows (FND-10). */
  const [finished, setFinished] = useState(false);
  const [done, setDone] = useState<{ confirmed: number; dismissed: number; fp: number }>({
    confirmed: 0,
    dismissed: 0,
    fp: 0,
  });
  const noteRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
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
  /**
   * Decisions the server accepted this session, by finding (W20-13, UX_TODO
   * FND-72). The queue is a frozen copy of the list, so going back to a
   * finding just confirmed still read "open", and pressing c again earned a
   * 409. The status shown is the server's answer to OUR request, never the
   * key pressed.
   */
  const [decided, setDecided] = useState<Record<number, Decision>>({});
  const [shortcuts, setShortcuts] = useState(readShortcutsPref);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const current = queue[index];
  const last = queue.length - 1;
  // Read by a decision's success callback, which runs after renders the
  // closure that started it never saw.
  const indexRef = useRef(index);
  indexRef.current = index;

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

  const goNext = () => {
    if (index >= last) setFinished(true);
    else setIndex((i) => Math.min(i + 1, last));
  };
  const goPrev = () => {
    // From the end-of-page summary, back is the last finding itself.
    if (finished) setFinished(false);
    else setIndex((i) => Math.max(i - 1, 0));
  };

  function decide(status: Decision) {
    if (!current) return;
    // Refused with a sentence, not silently: a key that does nothing reads as
    // a broken shortcut. Focus goes where the missing input is.
    if (note.trim() === '') {
      setHint('Write a note first. It is recorded with each decision.');
      noteRef.current?.focus();
      return;
    }
    if (status === 'dismissed' && reason === '') {
      setHint('Choose a dismiss reason first (keys 1–4, or the picker).');
      reasonRef.current?.focus();
      return;
    }
    setHint(null);
    // Only the SAME decision on the SAME finding is held back while it is
    // pending (W17-23) — a second `c` would be a duplicate write. Moving on
    // and deciding the next finding is not, and must not wait.
    if (inFlight?.id === current.id && inFlight.status === status) return;
    if (decided[current.id] === status) {
      setHint(`Already ${status} in this session.`);
      return;
    }
    const id = current.id;
    const at = index;
    const chosen = reason;
    setInFlight({ id, status });
    setRefused((r) => (r?.id === id ? null : r));
    transition.mutate(
      status === 'confirmed' ? { status, note } : { status, note, dismiss_reason: chosen },
      {
        onSuccess: () => {
          setDecided((m) => ({ ...m, [id]: status }));
          setDone((d) => ({
            ...d,
            [status]: d[status] + 1,
            fp: d.fp + (status === 'dismissed' && chosen === 'false_positive' ? 1 : 0),
          }));
          // Advance only if the cursor is still on the finding decided:
          // someone who pressed j while waiting has already moved. The last
          // one ends the page rather than sitting on it.
          if (indexRef.current !== at) return;
          if (at === last) setFinished(true);
          else setIndex(at + 1);
        },
        onError: (error) => setRefused({ id, error }),
        onSettled: () => setInFlight((f) => (f?.id === id && f.status === status ? null : f)),
      },
    );
  }

  // The latest handlers, for the one window listener below.
  const keys = useRef({ decide, goNext, goPrev, onExit, shortcuts });
  keys.current = { decide, goNext, goPrev, onExit, shortcuts };

  // Focus starts inside the dialog, on what it is about (FND-34).
  useEffect(() => {
    headingRef.current?.focus();
  }, [index, finished]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore while typing the note or using the picker, or every keystroke
      // would triage.
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      const k = keys.current;
      if (e.key === 'Escape') k.onExit();
      // Escape always works; the letters only while shortcuts are on, and
      // never with a modifier held (that is someone else's shortcut).
      if (!k.shortcuts || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'j') k.goNext();
      if (e.key === 'k') k.goPrev();
      if (e.key === 'c') k.decide('confirmed');
      if (e.key === 'd') k.decide('dismissed');
      const pick = DISMISS_REASONS[Number(e.key) - 1];
      if (pick) {
        setReason(pick);
        setHint(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const summary = `${done.confirmed} confirmed · ${done.dismissed} dismissed (${done.fp} as false positive) this session`;

  if (finished) {
    // THE END OF THE PAGE SAYS SO (FND-10). After the last item the queue
    // used to sit on it, with nothing to say the page was done or that the
    // list had more.
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-8"
        data-testid="triage-queue"
        role="dialog"
        aria-modal="true"
        aria-label="Findings triage queue"
        onKeyDown={trapTab}
      >
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
            End of this page
          </h2>
          <p className="text-sm" data-testid="triage-summary">
            {summary}
          </p>
          <p className="text-xs text-fg-muted" data-testid="triage-end-note">
            {next && onNextPage
              ? 'More findings match these filters on the next page.'
              : 'This was the last page of findings matching these filters.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {next && onNextPage && (
              <button
                type="button"
                className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="triage-next-page"
                onClick={() => onNextPage(next)}
              >
                Continue with the next page
              </button>
            )}
            <button type="button" className={BUTTON} data-testid="triage-back" onClick={goPrev}>
              Back to the last finding
            </button>
            <button type="button" className={BUTTON} data-testid="triage-exit" onClick={onExit}>
              Exit queue
            </button>
          </div>
        </div>
      </div>
    );
  }

  const pendingHere = inFlight?.id === current.id ? inFlight.status : null;
  const noteMissing = note.trim() === '';
  const decidedHere = decided[current.id];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col gap-4 overflow-auto bg-bg/95 p-8 backdrop-blur"
      data-testid="triage-queue"
      role="dialog"
      aria-modal="true"
      aria-label="Findings triage queue"
      onKeyDown={trapTab}
    >
      <div className="flex items-baseline gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="flex-1 text-lg font-semibold outline-none">
          {current.title}
          {current.experimental ? <ShadowBadge className="ml-2" /> : null}
        </h2>
        <span className="text-xs text-fg-muted" data-testid="triage-position">
          {index + 1} of {queue.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
        <span>{SEVERITY_LABEL[current.severity]}</span>
        <span>{dimensionLabel(current.dimension)}</span>
        <span>{verifyLabelOf(current)}</span>
        {/* W20-13 (FND-35): a repository-level CVE read "null:null". */}
        <span className="font-mono" data-testid="triage-location">
          {current.forge ? (
            <a
              href={current.forge.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="triage-forge-link"
            >
              {locationOf(current)}
            </a>
          ) : (
            locationOf(current)
          )}
        </span>
        {/* The server's status, never the key just pressed (W17-23); after a
            decision here, the server's answer to it (FND-72). */}
        <span data-testid="triage-status">
          Status: {statusLabel(decidedHere ?? current.status)}
          {decidedHere ? ' · decided this session' : ''}
        </span>
      </div>

      {/* Evidence inline — the whole reason a stepper beats a list: the thing
          you need in order to decide is already on screen. */}
      <EvidenceCode finding={current} />
      <p className="text-sm">{current.recommendation}</p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex max-w-lg flex-1 flex-col gap-1 text-xs text-fg-muted">
          Note applied to each decision (required)
          <input
            ref={noteRef}
            className="panel px-2 py-1 text-sm"
            data-testid="triage-note"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setHint(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Dismiss reason
          <select
            ref={reasonRef}
            className="panel px-2 py-1 text-sm"
            data-testid="triage-reason"
            value={reason}
            onChange={(e) => {
              setReason(isDismissReason(e.target.value) ? e.target.value : '');
              setHint(null);
            }}
          >
            <option value="">Choose a reason…</option>
            {DISMISS_REASONS.map((r, i) => (
              <option key={r} value={r}>
                {i + 1}. {DISMISS_REASON_LABEL[r].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Visible buttons that mirror the keys (FND-09). On a phone or tablet
          there is no keyboard, and the queue was a dead end with Exit as its
          only control. */}
      <div className="flex flex-wrap gap-2" data-testid="triage-actions">
        <button
          type="button"
          className={BUTTON}
          data-testid="triage-prev"
          disabled={index === 0}
          onClick={goPrev}
        >
          Previous (k)
        </button>
        <button type="button" className={BUTTON} data-testid="triage-next" onClick={goNext}>
          Next (j)
        </button>
        <button
          type="button"
          className={BUTTON}
          data-testid="triage-confirm"
          disabled={noteMissing || pendingHere === 'confirmed' || decidedHere === 'confirmed'}
          onClick={() => decide('confirmed')}
        >
          Confirm (c)
        </button>
        <button
          type="button"
          className={BUTTON}
          data-testid="triage-dismiss"
          disabled={
            noteMissing ||
            reason === '' ||
            pendingHere === 'dismissed' ||
            decidedHere === 'dismissed'
          }
          onClick={() => decide('dismissed')}
        >
          Dismiss (d)
        </button>
        <button type="button" className={BUTTON} data-testid="triage-exit" onClick={onExit}>
          Exit queue (esc)
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="triage-shortcuts"
            checked={shortcuts}
            onChange={(e) => {
              setShortcuts(e.target.checked);
              writeShortcutsPref(e.target.checked);
            }}
          />
          Single-key shortcuts
        </label>
        <kbd className="rounded border border-border px-1">j</kbd> next
        <kbd className="rounded border border-border px-1">k</kbd> previous
        <kbd className="rounded border border-border px-1">c</kbd> confirm
        <kbd className="rounded border border-border px-1">1</kbd>–
        <kbd className="rounded border border-border px-1">4</kbd> dismiss reason
        <kbd className="rounded border border-border px-1">d</kbd> dismiss
        <kbd className="rounded border border-border px-1">esc</kbd> exit
      </div>

      {hint && (
        <p className="text-xs" data-testid="triage-hint" role="status">
          {hint}
        </p>
      )}
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
        {summary}
      </p>
    </div>
  );
}
