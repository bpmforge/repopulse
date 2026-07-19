import { jobId, QUEUE } from '../queues/topology.js';

// Webhook event → typed delta job routing (INGESTION §4, FR-INGEST-5/6).
// The payload is only a doorbell: a delta job re-pulls by cursor, so a
// dropped/mangled payload self-heals and a replay is idempotent.

// The exact subscribed set (INGESTION §4 / research §4).
export const SUBSCRIBED_EVENTS = [
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
  'check_suite',
  'deployment_status',
  'release',
  'issues',
  'repository',
] as const;

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

// What a delta job re-pulls. `push_commits` is special: coalesced per repo.
export type DeltaKind =
  | 'push_commits'
  | 'pull_requests'
  | 'checks'
  | 'deployments'
  | 'releases'
  | 'issues'
  | 'repository';

const EVENT_TO_DELTA: Record<string, DeltaKind> = {
  push: 'push_commits',
  pull_request: 'pull_requests',
  pull_request_review: 'pull_requests',
  pull_request_review_comment: 'pull_requests',
  workflow_run: 'checks',
  check_suite: 'checks',
  deployment_status: 'deployments',
  release: 'releases',
  issues: 'issues',
  repository: 'repository',
};

/** Map a GitHub event to a delta kind, or null if we don't act on it. */
export function routeEvent(event: string): DeltaKind | null {
  return EVENT_TO_DELTA[event] ?? null;
}

export interface DeltaJobData {
  workspaceId: number;
  repoId: number;
  repo: string; // owner/name
  kind: DeltaKind;
}

export interface DeltaEnqueueSpec {
  queue: string;
  data: DeltaJobData;
  opts: { jobId: string; delayMs?: number };
}

const PUSH_DEBOUNCE_MS = 30_000;

/**
 * Build the enqueue spec for a delta. push events coalesce per repo — same
 * jobId `push:{repoId}` inside a 30s debounce window collapses a burst into one
 * commits-since-cursor pull (INGESTION §4, NFR-10). Everything else gets a
 * per-repo-per-kind jobId so concurrent unrelated deltas don't collide.
 */
export function deltaEnqueueSpec(data: DeltaJobData): DeltaEnqueueSpec {
  if (data.kind === 'push_commits') {
    return {
      queue: QUEUE.delta,
      data,
      opts: { jobId: jobId.push(data.repoId), delayMs: PUSH_DEBOUNCE_MS },
    };
  }
  return {
    queue: QUEUE.delta,
    data,
    opts: { jobId: `delta-${data.repoId}-${data.kind}` },
  };
}
