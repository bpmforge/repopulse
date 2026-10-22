import { useEffect, useState } from 'react';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';

// Intent control on the file drill-down (W6-09, FR-PLANS-5).
//
// W20-20 (UX_TODO DSH-36): a choice, a note and an explicit Save. The old row
// of buttons saved on click, so a note typed AFTER choosing was silently
// dropped, a saved note was never shown again, there was no way to clear the
// intent, a failed save said nothing, and each option's consequence lived in
// a hover-only tooltip.

const INTENTS = [
  { id: 'refactor', label: 'Refactor', hint: 'warns if the hotspot score has not improved' },
  { id: 'supervise', label: 'Supervise', hint: 'alerts on any decline' },
  { id: 'acknowledged', label: 'Acknowledged', hint: 'hidden from hotspot lists, still counted' },
] as const;

interface IntentRow {
  id: number;
  repo_id: number;
  path: string;
  intent: string;
  note: string | null;
  warn_after_months?: number;
  created_at?: string;
  /** W20-24 (UX_TODO DSH-37): the hotspot since the declaration. Older API: absent. */
  hotspot?: IntentHotspot;
}

interface IntentHotspot {
  first: { at: string; score: number } | null;
  latest: { at: string; score: number } | null;
  points: number;
  improved: boolean | null;
  warnings: { kind: string; months?: number; from: number; to: number }[];
}

/**
 * Whether the hotspot improved since the intent was declared (W20-24, UX_TODO
 * DSH-37), from the stored score history. Says "not enough history yet" when
 * there is one reading or none, rather than guessing.
 */
export function hotspotSinceIntent(row: IntentRow): string | null {
  const h = row.hotspot;
  if (!h || row.intent === 'acknowledged') return null;
  if (h.improved === null || !h.first || !h.latest) {
    return 'Not enough hotspot history since the intent was set to say whether it improved; it is recorded on each daily update.';
  }
  const scores = `${h.first.score.toFixed(2)} on ${h.first.at.slice(0, 10)} → ${h.latest.score.toFixed(2)} on ${h.latest.at.slice(0, 10)}`;
  const warning = h.warnings[0];
  if (warning?.kind === 'refactor_stalled') {
    const m = warning.months ?? 0;
    return `⚠ No improvement in ${m} month${m === 1 ? '' : 's'}: hotspot ${scores}.`;
  }
  if (warning?.kind === 'supervised_decline') return `⚠ Hotspot rising: ${scores}.`;
  return h.improved
    ? `Improved since the intent: hotspot ${scores}.`
    : `Not improved yet: hotspot ${scores}.`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long the intent has stood and, for a refactor, when it is due to be
 * judged (W20-20, UX_TODO DSH-37). Whether the score improved is
 * hotspotSinceIntent's line (W20-24).
 */
export function intentStatus(row: IntentRow, now: Date = new Date()): string | null {
  if (!row.created_at) return null;
  const since = new Date(row.created_at);
  if (Number.isNaN(since.getTime())) return null;
  const label = INTENTS.find((i) => i.id === row.intent)?.label ?? row.intent;
  const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
  const head = `${label} since ${since.toISOString().slice(0, 10)} (${days} day${days === 1 ? '' : 's'})`;
  if (row.intent !== 'refactor' || !row.warn_after_months) return head;
  const due = new Date(since.getTime() + row.warn_after_months * 30 * DAY_MS);
  const left = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
  return left > 0
    ? `${head} — review due ${due.toISOString().slice(0, 10)}, in ${left} day${left === 1 ? '' : 's'}`
    : `${head} — past its ${row.warn_after_months}-month review date; check the hotspot score has come down`;
}

export function IntentControl({ repoId, path }: { repoId: number; path: string }) {
  const listDescriptor = { endpoint: '/intents', query: { repo_id: String(repoId) } } as const;
  const { data } = useApiQuery<{ items: IntentRow[] }>(listDescriptor);
  const current = data?.items.find((i) => i.path === path);

  const [choice, setChoice] = useState<string>('');
  const [note, setNote] = useState('');
  // Load the saved intent and note into the form once they arrive, and again
  // whenever they change underneath (a save, or another tab).
  useEffect(() => {
    setChoice(current?.intent ?? '');
    setNote(current?.note ?? '');
  }, [current?.intent, current?.note]);

  const invalidate = [queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/hotspots' })];
  const save = useApiMutation<
    { repo_id: number; path: string; intent: string; note: string },
    unknown
  >({ endpoint: '/intents', method: 'PUT' }, { invalidate });
  const clear = useApiMutation<undefined, unknown>(
    { endpoint: '/intents', method: 'DELETE', query: { repo_id: String(repoId), path } },
    { invalidate },
  );

  const busy = save.isPending || clear.isPending;
  const dirty = choice !== (current?.intent ?? '') || note !== (current?.note ?? '');
  const status = current ? intentStatus(current) : null;
  const sinceLine = current ? hotspotSinceIntent(current) : null;

  return (
    <form
      className="flex flex-col gap-2"
      data-testid="intent-control"
      onSubmit={(e) => {
        e.preventDefault();
        if (!choice) return;
        clear.reset();
        save.mutate({ repo_id: repoId, path, intent: choice, note });
      }}
    >
      <p className="text-xs" data-testid="intent-current">
        {current ? (
          <>
            <span className="font-medium">{status}</span>
            {current.note ? <span className="text-fg-muted"> · “{current.note}”</span> : null}
            {sinceLine && (
              <span
                className={`block ${current.hotspot?.warnings.length ? 'text-warn' : 'text-fg-muted'}`}
                data-testid="intent-hotspot"
              >
                {sinceLine}
              </span>
            )}
          </>
        ) : (
          <span className="text-fg-muted">
            No intent set — this file behaves normally everywhere.
          </span>
        )}
      </p>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-fg-muted">Intent</legend>
        {/* The consequence is visible text beside each choice, not a hover
            tooltip: "Acknowledged" hides the file from a leaderboard, which is
            a decision worth understanding before making it. */}
        {INTENTS.map((option) => (
          <label key={option.id} className="flex items-baseline gap-2 text-xs">
            <input
              type="radio"
              name={`intent-${repoId}-${path}`}
              value={option.id}
              checked={choice === option.id}
              onChange={() => setChoice(option.id)}
              data-testid={`intent-${option.id}`}
            />
            <span className="font-medium">{option.label}</span>
            <span className="text-fg-muted">— {option.hint}</span>
          </label>
        ))}
      </fieldset>
      <input
        className="w-full max-w-md panel px-2 py-1 text-xs"
        data-testid="intent-note"
        // A placeholder is not a label (W18-28).
        aria-label="Why this intent (optional)"
        placeholder="Why (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="rounded-md border border-accent bg-accent/10 px-2 py-0.5 text-xs hover:bg-accent/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          data-testid="intent-save"
          disabled={busy || !choice || !dirty}
        >
          {save.isPending ? 'Saving…' : 'Save intent'}
        </button>
        {current && (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="intent-clear"
            disabled={busy}
            onClick={() => {
              save.reset();
              clear.mutate(undefined);
            }}
          >
            {clear.isPending ? 'Clearing…' : 'Clear intent'}
          </button>
        )}
      </div>
      <ErrorNote error={save.error ?? clear.error} testId="intent-error" />
    </form>
  );
}
