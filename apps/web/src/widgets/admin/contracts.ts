// Admin contracts (W4-08). Source of truth: apps/api/src/routes/{connections,sync}.

export interface ConnectionSummary {
  id: number;
  provider: string;
  /** Per-connection forge host (W14-02). Null = the server default. */
  base_url: string | null;
  auth_kind: string;
  fingerprint: string;
  /** Last 4 of the credential fingerprint — never the credential itself (SC-2). */
  last4: string;
  status: string;
  repo_count: number;
}

export interface ConnectionList {
  items: ConnectionSummary[];
}

export interface AvailableRepo {
  forge_repo_id: string;
  org: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
}

export interface AvailableRepos {
  items: AvailableRepo[];
}

export type SyncPhase =
  'error' | 'paused_budget' | 'paused' | 'queued' | 'history' | 'live' | string;

export interface RepoSyncStatus {
  repoId: string;
  phase: SyncPhase;
  percentComplete: number;
  entities: Record<string, { cursorAt: string | null; done: boolean }>;
  budget: { remaining: number; limit: number; resetAt: string | null; spent24h: number };
  lagSeconds: number | null;
  lastError: { at: string; message: string; jobId: string | null } | null;
  lastSyncedAt: string | null;
}

export interface OrgSyncStatus {
  phase: SyncPhase;
  repoCount: number;
  percentComplete: number;
  worstLagSeconds: number | null;
  repos: RepoSyncStatus[];
}

/**
 * Phases that mean "needs a human", worst first (INGESTION §7 severity order).
 * Used to colour the row, so it must match the API's own ordering rather than
 * being re-derived — a paused-for-budget repo is not an error and must not be
 * shown as one.
 */
export const ATTENTION_PHASES: SyncPhase[] = ['error', 'paused_budget', 'paused'];

export function phaseSeverity(phase: SyncPhase): 'high' | 'medium' | 'low' {
  if (phase === 'error') return 'high';
  if (phase === 'paused' || phase === 'paused_budget') return 'medium';
  return 'low';
}

/** Human lag, or an em dash — never "0s", which reads as freshly synced. */
export function formatLag(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}
