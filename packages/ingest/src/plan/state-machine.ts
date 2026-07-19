// Per-repo sync state machine (FR-INGEST-8), verbatim from INGESTION.md §2.
//
// The conceptual phases below are finer-grained than the DB's `repos.sync_status`
// column (W1-01): `history` and `enrichment` both persist as `backfilling`.
// syncPhaseToRepoStatus() maps the phase to the coarser stored status so the
// dashboard reads one column while the ingest engine tracks the full machine.

export type SyncPhase = 'queued' | 'history' | 'enrichment' | 'live' | 'paused_budget' | 'error';

export type SyncEvent =
  | 'plan_ran' // queued → history
  | 'history_complete' // history → enrichment (all entity cursors reached window start)
  | 'enrichment_complete' // enrichment → live
  | 'budget_floor_hit' // history|enrichment → paused_budget
  | 'budget_reset' // paused_budget → history
  | 'repeated_failure' // live → error
  | 'manual_retry'; // error → live

// Allowed transitions. Anything not listed is rejected (nextPhase throws) — an
// illegal transition is a bug, not a silent no-op.
const TRANSITIONS: Record<SyncPhase, Partial<Record<SyncEvent, SyncPhase>>> = {
  queued: { plan_ran: 'history' },
  history: {
    history_complete: 'enrichment',
    budget_floor_hit: 'paused_budget',
  },
  enrichment: {
    enrichment_complete: 'live',
    budget_floor_hit: 'paused_budget',
  },
  paused_budget: { budget_reset: 'history' },
  live: { repeated_failure: 'error' },
  error: { manual_retry: 'live' },
};

export function canTransition(from: SyncPhase, event: SyncEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function nextPhase(from: SyncPhase, event: SyncEvent): SyncPhase {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new Error(`illegal sync transition: ${from} --${event}-->`);
  }
  return to;
}

export type RepoSyncStatus =
  'pending_backfill' | 'backfilling' | 'live' | 'error' | 'paused_budget' | 'paused';

export function syncPhaseToRepoStatus(phase: SyncPhase): RepoSyncStatus {
  switch (phase) {
    case 'queued':
      return 'pending_backfill';
    case 'history':
    case 'enrichment':
      return 'backfilling';
    case 'live':
      return 'live';
    case 'paused_budget':
      return 'paused_budget';
    case 'error':
      return 'error';
  }
}

/** The dashboard is usable from `enrichment` onward (INGESTION §2). */
export function isDashboardReady(phase: SyncPhase): boolean {
  return phase === 'enrichment' || phase === 'live';
}
