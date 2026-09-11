import { useState } from 'react';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Intent control on the file drill-down (W6-09, FR-PLANS-5).

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
}

export function IntentControl({ repoId, path }: { repoId: number; path: string }) {
  const listDescriptor = { endpoint: '/intents', query: { repo_id: String(repoId) } } as const;
  const { data } = useApiQuery<{ items: IntentRow[] }>(listDescriptor);
  const current = data?.items.find((i) => i.path === path);
  const [note, setNote] = useState('');

  const setIntent = useApiMutation<
    { repo_id: number; path: string; intent: string; note: string },
    unknown
  >(
    { endpoint: '/intents', method: 'PUT' },
    { invalidate: [queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/hotspots' })] },
  );

  return (
    <div className="flex flex-col gap-2" data-testid="intent-control">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-fg-muted">Intent:</span>
        {INTENTS.map((option) => {
          const active = current?.intent === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={`rounded-md border px-2 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                active ? 'border-accent bg-accent/10' : 'border-border hover:border-accent'
              }`}
              data-testid={`intent-${option.id}`}
              aria-pressed={active}
              title={option.hint}
              disabled={setIntent.isPending}
              onClick={() => setIntent.mutate({ repo_id: repoId, path, intent: option.id, note })}
            >
              {/* Paired mark + word: the active state must not rest on colour. */}
              {active ? '● ' : '○ '}
              {option.label}
            </button>
          );
        })}
      </div>
      {/* The consequence, stated before the click rather than discovered after.
          "Acknowledged" hides the file from a leaderboard, which is a decision
          worth understanding at the moment you make it. */}
      <p className="text-xs text-fg-muted">
        {current
          ? INTENTS.find((i) => i.id === current.intent)?.hint
          : 'No intent set — this file behaves normally everywhere.'}
      </p>
      <input
        className="w-full max-w-md panel px-2 py-1 text-xs"
        data-testid="intent-note"
        placeholder="Why (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </div>
  );
}
