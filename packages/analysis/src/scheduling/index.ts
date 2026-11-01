import type { Dimension } from '../gateway/types.js';

// Analysis scheduling (W6-01, FR-ANALYSIS-8, NFR-7).

export type RepoPolicy = 'auto' | 'manual' | 'off';

export interface ReviewJobKey {
  repoId: number;
  prNumber: number;
  headSha: string;
  dimension: Dimension;
}

/**
 * Idempotency key (ANALYSIS_TIERS.md §1).
 *
 * headSha is in the key on purpose: a new push to the same PR SHOULD be
 * reviewed again, and keying on the PR alone would silently skip it. Equally,
 * re-delivering the same webhook must not double-spend a LAN model, which is
 * what everything else in the key prevents.
 */
export const ANALYSIS_REVIEW_QUEUE = 'analysis.review';

export function reviewJobId(key: ReviewJobKey): string {
  return `an:${key.repoId}:${key.prNumber}:${key.headSha}:${key.dimension}`;
}

export interface ScheduleDecision {
  enqueue: boolean;
  reason: string;
}

/**
 * Whether a webhook-triggered review should be enqueued.
 *
 * `manual` is a real answer, not a synonym for off: the work is allowed, it
 * just is not started by an event. Collapsing the two would either spend model
 * time nobody asked for, or make a "Review now" button do nothing.
 */
export function shouldEnqueue(policy: RepoPolicy, trigger: 'webhook' | 'manual'): ScheduleDecision {
  if (policy === 'off') {
    return { enqueue: false, reason: 'Analysis is off for this repository.' };
  }
  if (policy === 'manual' && trigger === 'webhook') {
    return {
      enqueue: false,
      reason: 'Analysis is manual for this repository — a person starts it, an event does not.',
    };
  }
  return { enqueue: true, reason: `policy=${policy}, trigger=${trigger}` };
}

export interface HostStatus {
  baseUrl: string;
  reachable: boolean;
  inFlight: number;
}

/**
 * NFR-7 degradation state, shaped for the UI banner.
 *
 * `paused` is deliberately distinct from `saturated`: an unreachable host is a
 * closed laptop and needs a human; a saturated one is working and needs
 * patience. One banner for both would send people looking for a fault that is
 * not there — and neither must touch a Tier-1 dashboard.
 */
export function analysisStatus(hosts: readonly HostStatus[], cap: number): {
  state: 'ok' | 'saturated' | 'paused';
  banner: string | null;
} {
  if (hosts.length === 0) {
    return { state: 'paused', banner: 'Tier-2 analysis is not configured — no LAN host is set.' };
  }
  if (hosts.every((h) => !h.reachable)) {
    return { state: 'paused', banner: 'Tier-2 analysis paused — host unreachable.' };
  }
  const reachable = hosts.filter((h) => h.reachable);
  if (reachable.every((h) => h.inFlight >= cap)) {
    return { state: 'saturated', banner: 'Tier-2 analysis is busy — queued behind running reviews.' };
  }
  return { state: 'ok', banner: null };
}

export * from './incremental.js';
