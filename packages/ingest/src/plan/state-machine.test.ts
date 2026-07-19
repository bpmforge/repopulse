import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isDashboardReady,
  nextPhase,
  syncPhaseToRepoStatus,
  type SyncPhase,
} from './state-machine.js';

describe('sync state machine (INGESTION §2, FR-INGEST-8)', () => {
  it('walks the happy path queued → history → enrichment → live', () => {
    expect(nextPhase('queued', 'plan_ran')).toBe('history');
    expect(nextPhase('history', 'history_complete')).toBe('enrichment');
    expect(nextPhase('enrichment', 'enrichment_complete')).toBe('live');
  });

  it('pauses on budget floor from history or enrichment and resumes to history', () => {
    expect(nextPhase('history', 'budget_floor_hit')).toBe('paused_budget');
    expect(nextPhase('enrichment', 'budget_floor_hit')).toBe('paused_budget');
    expect(nextPhase('paused_budget', 'budget_reset')).toBe('history');
  });

  it('live → error on repeated failure, error → live on manual retry', () => {
    expect(nextPhase('live', 'repeated_failure')).toBe('error');
    expect(nextPhase('error', 'manual_retry')).toBe('live');
  });

  it('throws on an illegal transition (bug, not a silent no-op)', () => {
    expect(() => nextPhase('queued', 'enrichment_complete')).toThrow(/illegal sync transition/);
    expect(canTransition('live', 'plan_ran')).toBe(false);
  });

  it('maps the fine-grained phase to the coarser repos.sync_status column', () => {
    const cases: [SyncPhase, string][] = [
      ['queued', 'pending_backfill'],
      ['history', 'backfilling'],
      ['enrichment', 'backfilling'],
      ['live', 'live'],
      ['paused_budget', 'paused_budget'],
      ['error', 'error'],
    ];
    for (const [phase, status] of cases) expect(syncPhaseToRepoStatus(phase)).toBe(status);
  });

  it('marks the dashboard usable from enrichment onward', () => {
    expect(isDashboardReady('history')).toBe(false);
    expect(isDashboardReady('enrichment')).toBe(true);
    expect(isDashboardReady('live')).toBe(true);
  });
});
