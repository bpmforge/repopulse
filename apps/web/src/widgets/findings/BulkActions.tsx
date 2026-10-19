import { useState } from 'react';
import { ErrorNote, WidgetFrame } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import {
  DISMISS_REASONS,
  FINDING_ACTIONS,
  FINDING_DONE_LABEL,
  allowedFindingTransitions,
  isDismissReason,
  undoTargetFor,
  type DismissReason,
  type Finding,
  type FindingLifecycleStatus,
} from './contracts.js';

// The Reviews bulk bar and what it last did (W17-23, W20-03).
//
// W20-03 (UX_TODO FND-11, FND-13, FND-02): the bar offered only Mark confirmed
// and Mark dismissed, sent no dismiss reason, dismissed any number of findings
// on one click, and could not be taken back. It now offers every move the
// lifecycle allows for the selection, requires a reason to dismiss, asks first
// before dismissing more than DISMISS_CONFIRM_OVER, and offers Undo where the
// lifecycle has a way back.

/** Above this many, a bulk dismissal asks first (FND-13). */
export const DISMISS_CONFIRM_OVER = 5;

/** The order the bar offers moves in: forward first, reopen last. */
const ORDER: FindingLifecycleStatus[] = ['confirmed', 'resolved', 'wont_fix', 'dismissed', 'open'];

const REASON_LABEL: Record<DismissReason, string> = {
  false_positive: 'False positive',
  accepted_risk: 'Accepted risk',
  not_applicable: 'Not applicable',
  duplicate: 'Duplicate',
};

const BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** POST /findings/bulk — applied ids and the ones the lifecycle refused. */
export interface BulkResult {
  applied: number[];
  skipped: { id: number; reason: string }[];
}

interface BulkBody {
  ids: number[];
  status: string;
  note: string;
  dismiss_reason?: string;
}

/** What a bulk action did, with what each finding was before it (for Undo). */
interface LastBulk {
  result: BulkResult;
  to: FindingLifecycleStatus;
  before: Record<number, { status: string; reason: string | null }>;
  undone: number | null;
}

/**
 * The moves the bar offers: those the lifecycle allows for at least one
 * selected finding. The API still decides per row and reports the rest.
 */
export function bulkMoves(selected: readonly Finding[]): FindingLifecycleStatus[] {
  const allowed = new Set(selected.flatMap((f) => allowedFindingTransitions(f.status)));
  return ORDER.filter((s) => allowed.has(s));
}

export function BulkActions({
  selected,
  onApplied,
  invalidate,
}: {
  selected: readonly Finding[];
  onApplied: () => void;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<DismissReason | ''>('');
  const [confirming, setConfirming] = useState(false);
  /**
   * What the last bulk action did, kept after the selection clears (W17-23).
   * The API applies what it can and reports the rest per id, and a bar that
   * simply emptied read as "all forty done" when three were already resolved.
   */
  const [last, setLast] = useState<LastBulk | null>(null);
  const bulk = useApiMutation<BulkBody, BulkResult>(
    { endpoint: '/findings/bulk', method: 'POST' },
    { invalidate },
  );
  const [undoError, setUndoError] = useState<unknown>(null);
  const [undoing, setUndoing] = useState(false);

  const moves = bulkMoves(selected);
  const ids = selected.map((f) => f.id);

  const run = (to: FindingLifecycleStatus) => {
    const before = Object.fromEntries(
      selected.map((f) => [f.id, { status: f.status, reason: f.dismiss_reason }]),
    );
    setConfirming(false);
    bulk.mutate(
      to === 'dismissed' && reason !== ''
        ? { ids, status: to, note, dismiss_reason: reason }
        : { ids, status: to, note },
      {
        onSuccess: (result) => {
          setNote('');
          setLast({ result, to, before, undone: null });
          setUndoError(null);
          onApplied();
        },
      },
    );
  };

  /**
   * Undo (FND-02): each applied finding goes back to where it was, in one
   * request per (status, reason) it came from. A finding whose way back the
   * lifecycle does not allow is counted and said, never attempted.
   */
  const undoGroups = (l: LastBulk) => {
    const groups = new Map<
      string,
      { status: FindingLifecycleStatus; reason: string | null; ids: number[] }
    >();
    let stuck = 0;
    for (const id of l.result.applied) {
      const was = l.before[id];
      const target = was ? undoTargetFor(was.status, l.to) : null;
      if (!was || !target) {
        stuck += 1;
        continue;
      }
      const reasonBack = target === 'dismissed' ? was.reason : null;
      const key = `${target}|${reasonBack ?? ''}`;
      const g = groups.get(key) ?? { status: target, reason: reasonBack, ids: [] };
      g.ids.push(id);
      groups.set(key, g);
    }
    return { groups: [...groups.values()], stuck };
  };

  const undo = async (l: LastBulk) => {
    const { groups } = undoGroups(l);
    setUndoing(true);
    setUndoError(null);
    let reverted = 0;
    try {
      for (const g of groups) {
        const r = await bulk.mutateAsync({
          ids: g.ids,
          status: g.status,
          note: `Undo of bulk ${FINDING_ACTIONS[l.to].label}`,
          ...(g.reason ? { dismiss_reason: g.reason } : {}),
        });
        reverted += r.applied.length;
      }
      setLast({ ...l, undone: reverted });
    } catch (error) {
      setUndoError(error);
    } finally {
      setUndoing(false);
    }
  };

  const noteMissing = note.trim() === '';

  return (
    <>
      {selected.length > 0 && (
        <WidgetFrame title={`${selected.length} selected`} state="ready">
          <div className="flex flex-wrap items-end gap-2" data-testid="bulk-bar">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Note (required)
              <input
                className="w-72 panel px-2 py-1 text-sm"
                data-testid="bulk-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {moves.includes('dismissed') && (
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Dismiss reason
                <select
                  className="panel px-2 py-1 text-sm"
                  data-testid="bulk-dismiss-reason"
                  value={reason}
                  onChange={(e) => {
                    setReason(isDismissReason(e.target.value) ? e.target.value : '');
                    setConfirming(false);
                  }}
                >
                  <option value="">Choose a reason…</option>
                  {DISMISS_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {moves.map((to) => {
              const action = FINDING_ACTIONS[to];
              // Only the button that was pressed waits (W17-23); the others
              // stay live rather than the whole bar greying out.
              const pending = bulk.isPending && bulk.variables?.status === to;
              const needsReason = to === 'dismissed' && reason === '';
              return (
                <button
                  key={to}
                  type="button"
                  className={BUTTON}
                  data-testid={`bulk-${to}`}
                  title={needsReason ? 'Choose a dismiss reason first.' : action.hint}
                  disabled={pending || noteMissing || needsReason}
                  aria-busy={pending || undefined}
                  onClick={() => {
                    if (to === 'dismissed' && selected.length > DISMISS_CONFIRM_OVER) {
                      setConfirming(true);
                      return;
                    }
                    run(to);
                  }}
                >
                  {pending ? action.busy : action.label}
                </button>
              );
            })}
          </div>
          {confirming && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 text-sm"
              data-testid="bulk-dismiss-confirm"
              role="alertdialog"
              aria-label="Confirm bulk dismissal"
            >
              <span>
                Dismiss {selected.length} findings as{' '}
                {reason ? REASON_LABEL[reason].toLowerCase() : 'dismissed'}?
              </span>
              {/* Neutral, not accent: the destructive step is never the
                  visually suggested one. */}
              <button
                type="button"
                className={BUTTON}
                data-testid="bulk-dismiss-confirm-yes"
                onClick={() => run('dismissed')}
              >
                Dismiss {selected.length}
              </button>
              <button
                type="button"
                className={BUTTON}
                data-testid="bulk-dismiss-confirm-no"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          )}
          <ErrorNote error={bulk.error} testId="bulk-error" className="mt-2" />
        </WidgetFrame>
      )}

      {last && (
        <LastBulkNote
          last={last}
          undoing={undoing}
          groups={undoGroups(last)}
          onUndo={() => void undo(last)}
        />
      )}
      {undoError ? <ErrorNote error={undoError} testId="bulk-undo-error" /> : null}
    </>
  );
}

function LastBulkNote({
  last,
  groups,
  undoing,
  onUndo,
}: {
  last: LastBulk;
  groups: { groups: { ids: number[] }[]; stuck: number };
  undoing: boolean;
  onUndo: () => void;
}) {
  const { result, to } = last;
  const reversible = groups.groups.reduce((n, g) => n + g.ids.length, 0);
  return (
    <p className="text-xs text-fg-muted" data-testid="bulk-result" role="status">
      {last.undone !== null ? (
        `Undone: ${last.undone} ${last.undone === 1 ? 'finding is' : 'findings are'} back where ${last.undone === 1 ? 'it was' : 'they were'}.`
      ) : (
        <>
          {FINDING_DONE_LABEL[to]}: applied to {result.applied.length}
          {result.skipped.length > 0
            ? `, skipped ${result.skipped.length} (${result.skipped
                .map((s) => `#${s.id}: ${s.reason}`)
                .join('; ')})`
            : ''}
          .{' '}
          {reversible > 0 && (
            <button
              type="button"
              className="text-accent underline underline-offset-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="bulk-undo"
              disabled={undoing}
              onClick={onUndo}
            >
              {undoing ? 'Undoing…' : `Undo (${reversible})`}
            </button>
          )}
          {groups.stuck > 0 && (
            <span data-testid="bulk-no-undo">
              {' '}
              {groups.stuck} cannot be undone: the lifecycle has no way from {to.replace('_', ' ')}{' '}
              back to where {groups.stuck === 1 ? 'it was' : 'they were'}.
            </span>
          )}
        </>
      )}
    </p>
  );
}
