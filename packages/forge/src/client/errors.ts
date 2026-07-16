import type { Lane } from '../types.js';

// Thrown when the primary or a secondary budget denies a request outright
// (never queued/waited on here - FR-INGEST-4 has the BullMQ job itself yield
// and reschedule when it catches this).
export class ForgeBudgetParkedError extends Error {
  constructor(
    readonly lane: Lane,
    readonly reason: 'primary-floor' | 'secondary-family' | 'graphql',
    readonly resumeAt: number | null,
  ) {
    super(`forge budget parked lane=${lane} reason=${reason} resumeAt=${resumeAt ?? 'unknown'}`);
    this.name = 'ForgeBudgetParkedError';
  }
}
