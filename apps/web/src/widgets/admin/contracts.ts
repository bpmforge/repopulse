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
  /** New repositories are tracked by the nightly sweep (W20-17, INS-09). */
  auto_add?: boolean;
  /** No webhooks; updates arrive with the nightly sync (W20-19, INS-69). */
  scheduled_sync_only?: boolean;
  /** When and by whom it was added (W20-22, UX_TODO ADM-50); optional for an older API. */
  created_at?: string;
  created_by?: string | null;
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
  /** Already tracked on this connection (W20-07, UX_TODO INS-10). */
  tracked?: boolean;
  /** The tracked repo's sync status; null when untracked. */
  sync_status?: string | null;
}

export interface AvailableRepos {
  items: AvailableRepo[];
  /** Every page, counted (W20-07, UX_TODO INS-52). */
  total?: number;
  /** True when the forge kept paging past the server's safety cap. */
  truncated?: boolean;
}

export type SyncPhase =
  'error' | 'paused_budget' | 'paused' | 'queued' | 'history' | 'live' | string;

export interface RepoSyncStatus {
  repoId: string;
  /** `org/name` — what a person calls the repository (W16-05, F11). */
  repoName?: string;
  /** Which connection it syncs through (W20-15, X-18). Optional for an older API. */
  connection?: { id: number; provider: string; host: string | null } | null;
  phase: SyncPhase;
  percentComplete: number;
  /**
   * `notEnabled` (W17-39): the repository has this feature switched off — shown
   * as information, never as an error. Optional so an older API still renders.
   */
  entities: Record<
    string,
    { cursorAt: string | null; done: boolean; error: string | null; notEnabled?: boolean }
  >;
  budget: { remaining: number; limit: number; resetAt: string | null; spent24h: number };
  lagSeconds: number | null;
  lastError: { at: string; message: string; jobId: string | null } | null;
  lastSyncedAt: string | null;
  /** Newest webhook delivery for the repo (W20-14, INS-32); absent from an older API. */
  lastWebhookAt?: string | null;
}

const ENTITY_LABEL: Record<string, string> = {
  prs: 'pull requests',
  issues: 'issues',
  releases: 'releases',
  commits: 'commits',
  deployments: 'deployments',
};

/** "issues and releases not enabled on this repo", or null when every feature is on. */
export function notEnabledText(entities: RepoSyncStatus['entities']): string | null {
  const off = Object.entries(entities)
    .filter(([, e]) => e.notEnabled === true)
    .map(([k]) => ENTITY_LABEL[k] ?? k);
  if (off.length === 0) return null;
  const list = off.length === 1 ? off[0] : `${off.slice(0, -1).join(', ')} and ${off.at(-1)}`;
  return `${list} not enabled on this repo`;
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

/**
 * A sync phase in plain words (W20-14, UX_TODO INS-44 / ADM-41): the table
 * showed raw values such as "paused budget" and "history".
 */
export function phaseLabel(phase: SyncPhase): string {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'history':
      return 'Loading history';
    case 'enrichment':
      return 'Loading details';
    case 'live':
      return 'Up to date';
    case 'paused_budget':
      return 'Waiting for rate limit';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    default:
      return String(phase).replace(/_/g, ' ');
  }
}

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
