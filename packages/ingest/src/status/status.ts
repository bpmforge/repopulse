import { connectionHost } from '@repopulse/forge';
import { and, desc, eq, sql } from 'drizzle-orm';
import { core, facts, type Database } from '@repopulse/shared';

// Sync status model (INGESTION §7, FR-INGEST-8/FR-WEB-8). Computed entirely
// from the warehouse (FR-API-2 — the web app never calls a forge API): phase
// from repos.sync_status refined by entity cursors, percentComplete as
// 365-day time-coverage, lagSeconds from the newest high-watermark.

export type SyncStatusPhase =
  'queued' | 'history' | 'enrichment' | 'live' | 'paused_budget' | 'paused' | 'error';

export interface SyncStatus {
  repoId: string;
  /**
   * `org/name` (W16-05, F11). The status object carried only the numeric id, so
   * Settings → Sync listed repositories as 25152 / 25153 / 25154 — an internal
   * identifier shown to a person, on the one screen where they are trying to
   * work out which repository is stuck.
   */
  repoName: string;
  /**
   * Which connection the repository syncs through (W20-15, UX_TODO X-18): with
   * three forges connected, an admin could not tell which one was rate-limited
   * or failing. Null only for a repository whose connection row is gone.
   */
  connection: { id: number; provider: string; host: string | null } | null;
  phase: SyncStatusPhase;
  percentComplete: number;
  /** `error` (W17-35): why a finished entity holds no data, e.g. a 403 on issues. */
  entities: Record<
    string,
    {
      cursorAt: string | null;
      done: boolean;
      error: string | null;
      /** W17-39: the feature is switched off on the repo — informational, not an error. */
      notEnabled: boolean;
    }
  >;
  budget: { remaining: number; limit: number; resetAt: string | null; spent24h: number };
  lagSeconds: number | null;
  lastError: { at: string; message: string; jobId: string | null } | null;
  lastSyncedAt: string | null;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// The three entities with a usable "oldest ingested" timestamp for time-coverage.
const COVERAGE_ENTITIES = ['commits', 'prs', 'issues'] as const;

async function oldestNewest(
  db: Database,
  repoId: number,
  entity: (typeof COVERAGE_ENTITIES)[number],
): Promise<{ oldest: Date | null; newest: Date | null }> {
  const col =
    entity === 'commits'
      ? facts.commits.committedAt
      : entity === 'prs'
        ? facts.pullRequests.updatedAt
        : facts.issues.createdAt;
  const table =
    entity === 'commits' ? facts.commits : entity === 'prs' ? facts.pullRequests : facts.issues;
  const repoCol =
    entity === 'commits'
      ? facts.commits.repoId
      : entity === 'prs'
        ? facts.pullRequests.repoId
        : facts.issues.repoId;
  const [row] = await db
    .select({ oldest: sql<string | null>`min(${col})`, newest: sql<string | null>`max(${col})` })
    .from(table)
    .where(eq(repoCol, repoId));
  // Raw min/max come back as timestamp strings — parse to Date.
  return {
    oldest: row?.oldest ? new Date(row.oldest) : null,
    newest: row?.newest ? new Date(row.newest) : null,
  };
}

function refinePhase(
  syncStatus: string,
  entities: Record<string, { done: boolean }>,
): SyncStatusPhase {
  switch (syncStatus) {
    case 'pending_backfill':
      return 'queued';
    case 'backfilling': {
      // history until every entity cursor is done, then enrichment.
      const keys = Object.keys(entities);
      const allDone = keys.length > 0 && keys.every((k) => entities[k]?.done);
      return allDone ? 'enrichment' : 'history';
    }
    case 'live':
      return 'live';
    case 'paused_budget':
      return 'paused_budget';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    default:
      return 'queued';
  }
}

// The host a connection talks to is forge knowledge and lives in packages/forge;
// re-exported so existing importers of the status module keep working.
export { connectionHost };

export interface StatusClock {
  nowMs?: number;
}

/** Compute one repo's sync status from the warehouse. */
export async function repoSyncStatus(
  db: Database,
  repoId: number,
  clock: StatusClock = {},
): Promise<SyncStatus | null> {
  const nowMs = clock.nowMs ?? Date.now();
  const [repo] = await db
    .select({
      id: core.repos.id,
      org: core.repos.org,
      name: core.repos.name,
      syncStatus: core.repos.syncStatus,
      lastSyncedAt: core.repos.lastSyncedAt,
      lastError: core.repos.lastError,
      connectionId: core.forgeConnections.id,
      provider: core.forgeConnections.provider,
      baseUrl: core.forgeConnections.baseUrl,
    })
    .from(core.repos)
    .leftJoin(
      core.forgeConnections,
      and(
        eq(core.forgeConnections.id, core.repos.connectionId),
        eq(core.forgeConnections.workspaceId, core.repos.workspaceId),
      ),
    )
    .where(eq(core.repos.id, repoId))
    .limit(1);
  if (!repo) return null;

  const cursorRows = await db
    .select({
      entityType: core.syncCursors.entityType,
      cursorValue: core.syncCursors.cursorValue,
      backfillDone: core.syncCursors.backfillDone,
      lastError: core.syncCursors.lastError,
      featureDisabled: core.syncCursors.featureDisabled,
      updatedAt: core.syncCursors.updatedAt,
    })
    .from(core.syncCursors)
    .where(eq(core.syncCursors.repoId, repoId));

  const entities: SyncStatus['entities'] = {};
  for (const c of cursorRows) {
    entities[c.entityType] = {
      cursorAt: c.updatedAt ? c.updatedAt.toISOString() : null,
      done: c.backfillDone,
      error: c.lastError,
      notEnabled: c.featureDisabled,
    };
  }

  // percentComplete = min over entities of (now − oldest)/365d; lag from newest.
  let minCoverage = 1;
  let anyCoverage = false;
  let newestMs: number | null = null;
  for (const entity of COVERAGE_ENTITIES) {
    const { oldest, newest } = await oldestNewest(db, repoId, entity);
    if (oldest) {
      anyCoverage = true;
      const coverage = Math.min(1, Math.max(0, (nowMs - oldest.getTime()) / YEAR_MS));
      minCoverage = Math.min(minCoverage, coverage);
    }
    if (newest)
      newestMs = newestMs === null ? newest.getTime() : Math.max(newestMs, newest.getTime());
  }
  const percentComplete = anyCoverage ? Math.round(minCoverage * 100) : 0;
  const lagSeconds = newestMs === null ? null : Math.max(0, Math.round((nowMs - newestMs) / 1000));

  return {
    repoId: String(repo.id),
    repoName: `${repo.org}/${repo.name}`,
    connection:
      repo.connectionId === null || repo.provider === null
        ? null
        : {
            id: repo.connectionId,
            provider: repo.provider,
            host: connectionHost(repo.provider, repo.baseUrl),
          },
    phase: refinePhase(repo.syncStatus, entities),
    percentComplete,
    entities,
    // Live budget is a runtime gauge (ops /metrics + admin budget endpoint) —
    // not warehoused, so served as zero here until a budget-snapshot table
    // lands (documented). Everything else is warehouse-derived.
    budget: { remaining: 0, limit: 0, resetAt: null, spent24h: 0 },
    lagSeconds,
    lastError: repo.lastError
      ? { at: repo.lastSyncedAt?.toISOString() ?? '', message: repo.lastError, jobId: null }
      : null,
    lastSyncedAt: repo.lastSyncedAt ? repo.lastSyncedAt.toISOString() : null,
  };
}

export interface OrgSyncStatus {
  phase: SyncStatusPhase;
  repoCount: number;
  percentComplete: number;
  worstLagSeconds: number | null;
  repos: SyncStatus[];
}

// Worst phase first (most-attention-needed) for the banner.
const PHASE_SEVERITY: Record<SyncStatusPhase, number> = {
  error: 6,
  paused_budget: 5,
  paused: 4,
  queued: 3,
  history: 2,
  enrichment: 1,
  live: 0,
};

/** Org-level aggregate for the sync banner (worst phase, overall coverage). */
export async function orgSyncStatus(
  db: Database,
  workspaceId: number,
  clock: StatusClock = {},
): Promise<OrgSyncStatus> {
  const repoRows = await db
    .select({ id: core.repos.id })
    .from(core.repos)
    .where(eq(core.repos.workspaceId, workspaceId))
    .orderBy(desc(core.repos.id));
  const repos: SyncStatus[] = [];
  for (const r of repoRows) {
    const s = await repoSyncStatus(db, r.id, clock);
    if (s) repos.push(s);
  }

  let worstPhase: SyncStatusPhase = 'live';
  let worstLag: number | null = null;
  let sumPct = 0;
  for (const s of repos) {
    if (PHASE_SEVERITY[s.phase] > PHASE_SEVERITY[worstPhase]) worstPhase = s.phase;
    if (s.lagSeconds !== null)
      worstLag = worstLag === null ? s.lagSeconds : Math.max(worstLag, s.lagSeconds);
    sumPct += s.percentComplete;
  }
  return {
    phase: worstPhase,
    repoCount: repos.length,
    percentComplete: repos.length ? Math.round(sumPct / repos.length) : 0,
    worstLagSeconds: worstLag,
    repos,
  };
}
