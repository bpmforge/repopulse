import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { core, read, security, type Database } from '@repopulse/shared';

// ONE answer to "what has actually been measured about this repository, and
// how long ago?" (W17-10).
//
// Before this, three screens each worked it out for themselves: the repo page
// read scan runs, the overview read findings, and the scanners screen read
// enablement config. Any two of them could disagree, and the disagreement would
// look like a bug in whichever one the user happened to be reading.
//
// So this module is the CANONICAL PRODUCER. Everything downstream — repo pages,
// overview, settings — reads this shape. Adding a second producer is the thing
// this exists to prevent.
//
// It reports CAPABILITY AND FRESHNESS, not findings. "Nothing found" and
// "never looked" are different answers and this is where the difference lives.

/**
 * `not_configured` the operator has not set this up (no model, scanner off)
 * `not_supported`  RepoPulse cannot do this for this repository, ever
 * `queued`         accepted, not started
 * `running`        in progress right now
 * `succeeded`      the most recent attempt finished cleanly
 * `failed`         the most recent attempt failed
 *
 * `not_supported` is deliberately distinct from `not_configured`: coverage
 * ingestion and IaC scanning have reserved schema values and no implementation
 * (docs/NON_GOALS.md), and showing them as "off" would imply a switch exists.
 */
export type CapabilityState =
  'not_configured' | 'not_supported' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface Capability {
  /** Stable id: 'metadata', 'ai_review', or a scanner key. */
  id: string;
  label: string;
  kind: 'metadata' | 'ai_review' | 'scanner';
  state: CapabilityState;
  /**
   * The last time this SUCCEEDED, independent of `state`.
   *
   * A failed run must never erase the evidence of an earlier good one — the
   * findings from that run are still on screen and still real. So `state` can
   * be `failed` while this holds a timestamp, and both are true.
   */
  lastSuccessAt: string | null;
  /** The most recent run of any outcome, for "what happened last". */
  latestRunId: number | null;
  /** The commit the last SUCCESSFUL run measured, when recorded. Never faked. */
  lastSuccessRef: string | null;
  /**
   * Older than the freshness threshold.
   *
   * INDEPENDENT of state on purpose: a `succeeded` capability whose success was
   * three weeks ago is both succeeded and stale, and collapsing the two would
   * make one of them unsayable. `false` when nothing has ever succeeded —
   * "never measured" is not "stale", it is reported by lastSuccessAt being null.
   */
  stale: boolean;
  /** Human sentence for the UI. Never invents a measurement. */
  detail: string;
}

export interface RepoCapabilities {
  repoId: number;
  checkedAt: string;
  /** UI freshness hint, in hours. Not a security guarantee. */
  freshnessHours: number;
  capabilities: Capability[];
}

/**
 * Initial UI freshness threshold (W17-10).
 *
 * 24 hours, and documented as a DISPLAY hint: it means "we have not measured
 * this recently", nothing more. It is not a guarantee about anything, and no
 * security decision may be taken from it.
 */
export const FRESHNESS_HOURS = 24;

/**
 * Dimensions with a reserved schema value and no producer (docs/NON_GOALS.md).
 *
 * Listed explicitly rather than inferred, so shipping one is a deliberate edit
 * here rather than something that happens by accident. A reserved schema value
 * is not a shipped capability.
 */
export const UNSUPPORTED_CAPABILITIES: Record<string, string> = {
  test_coverage:
    'Coverage ingestion is not implemented in this release, so no coverage evidence exists for any repository.',
  iac: 'Infrastructure-as-code scanning is not implemented in this release.',
};

/** Map a stored run status onto a capability state. */
function stateFromRunStatus(status: string | null | undefined): CapabilityState {
  switch (status) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'in_progress':
      return 'running';
    case 'succeeded':
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'not_configured';
  }
}

function isStale(lastSuccessAt: Date | null, now: Date, hours = FRESHNESS_HOURS): boolean {
  if (!lastSuccessAt) return false; // never measured is not stale
  return now.getTime() - lastSuccessAt.getTime() > hours * 60 * 60 * 1000;
}

export interface RepoCapabilitiesOptions {
  now?: Date;
  freshnessHours?: number;
}

/**
 * The capability matrix for one repository.
 *
 * Workspace-scoped in every query: a repository id from another tenant returns
 * null rather than another workspace's evidence.
 */
export async function repoCapabilities(
  db: Database,
  workspaceId: number,
  repoId: number,
  opts: RepoCapabilitiesOptions = {},
): Promise<RepoCapabilities | null> {
  const now = opts.now ?? new Date();
  const freshnessHours = opts.freshnessHours ?? FRESHNESS_HOURS;

  const [repo] = await db
    .select({ id: core.repos.id, lastSyncedAt: core.repos.lastSyncedAt })
    .from(core.repos)
    .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
    .limit(1);
  if (!repo) return null;

  const capabilities: Capability[] = [];

  // ---- metadata (Tier 1) ---------------------------------------------------
  // Always supported and never "configured": connecting the forge is what turns
  // it on, and that is a different question, asked by /admin/system.
  const metaStale = isStale(repo.lastSyncedAt ?? null, now, freshnessHours);
  capabilities.push({
    id: 'metadata',
    label: 'Repository metadata and delivery history',
    kind: 'metadata',
    state: repo.lastSyncedAt ? 'succeeded' : 'not_configured',
    lastSuccessAt: repo.lastSyncedAt ? repo.lastSyncedAt.toISOString() : null,
    latestRunId: null,
    lastSuccessRef: null,
    stale: metaStale,
    detail: repo.lastSyncedAt
      ? metaStale
        ? 'Synced, but not in the last day — delivery figures may be behind.'
        : 'Synced from the forge API.'
      : 'Never synced. Nothing has been measured for this repository yet.',
  });

  // ---- AI review (Tier 2/3) ------------------------------------------------
  // Grouped, not per-dimension: an operator asks "is AI review working here?",
  // and four rows saying the same thing is noise. Per-dimension findings are on
  // the findings screens, where they belong.
  const [aiLatest] = await db
    .select({
      id: read.analysisRuns.id,
      status: read.analysisRuns.status,
      startedAt: read.analysisRuns.startedAt,
    })
    .from(read.analysisRuns)
    .where(
      and(eq(read.analysisRuns.workspaceId, workspaceId), eq(read.analysisRuns.repoId, repoId)),
    )
    .orderBy(desc(read.analysisRuns.startedAt))
    .limit(1);

  const [aiSuccess] = await db
    .select({ finishedAt: read.analysisRuns.finishedAt })
    .from(read.analysisRuns)
    .where(
      and(
        eq(read.analysisRuns.workspaceId, workspaceId),
        eq(read.analysisRuns.repoId, repoId),
        eq(read.analysisRuns.status, 'succeeded'),
        isNotNull(read.analysisRuns.finishedAt),
      ),
    )
    .orderBy(desc(read.analysisRuns.finishedAt))
    .limit(1);

  const [provider] = await db
    .select({ id: core.llmProviders.id })
    .from(core.llmProviders)
    .where(and(eq(core.llmProviders.workspaceId, workspaceId), eq(core.llmProviders.enabled, true)))
    .limit(1);

  const aiSuccessAt = aiSuccess?.finishedAt ?? null;
  const aiState: CapabilityState =
    !provider && !aiLatest ? 'not_configured' : stateFromRunStatus(aiLatest?.status);
  capabilities.push({
    id: 'ai_review',
    label: 'AI code review',
    kind: 'ai_review',
    state: aiState,
    lastSuccessAt: aiSuccessAt ? aiSuccessAt.toISOString() : null,
    latestRunId: aiLatest?.id ?? null,
    lastSuccessRef: null,
    stale: isStale(aiSuccessAt, now, freshnessHours),
    detail: !provider
      ? 'No model is enabled for this workspace. AI review is optional — metrics and deterministic scanners do not need one.'
      : aiState === 'failed' && aiSuccessAt
        ? 'The latest run failed. Findings from the last successful run are still shown and are still real.'
        : aiState === 'failed'
          ? 'The latest run failed and there is no earlier successful run.'
          : aiState === 'succeeded'
            ? 'A model reviewed this repository.'
            : aiState === 'not_configured'
              ? 'A model is configured but has not reviewed this repository yet.'
              : 'A review is in progress.',
  });

  // ---- scanners ------------------------------------------------------------
  // Per scanner key that has EVER run here, plus the reserved-but-unshipped
  // ones, which must read as unavailable rather than as a clean result.
  const scanRows = await db
    .select({
      scannerKey: security.scanRuns.scannerKey,
      latestId: sql<number>`max(${security.scanRuns.id})`,
      latestStatus: sql<
        string | null
      >`(array_agg(${security.scanRuns.status} order by ${security.scanRuns.startedAt} desc))[1]`,
      lastSuccessAt: sql<
        string | null
      >`max(${security.scanRuns.finishedAt}) filter (where ${security.scanRuns.status} = 'succeeded')`,
      lastSuccessRef: sql<
        string | null
      >`(array_agg(${security.scanRuns.commitSha} order by ${security.scanRuns.finishedAt} desc) filter (where ${security.scanRuns.status} = 'succeeded'))[1]`,
    })
    .from(security.scanRuns)
    .where(
      and(eq(security.scanRuns.workspaceId, workspaceId), eq(security.scanRuns.repoId, repoId)),
    )
    .groupBy(security.scanRuns.scannerKey);

  for (const row of scanRows) {
    const successAt = row.lastSuccessAt ? new Date(row.lastSuccessAt) : null;
    const state = stateFromRunStatus(row.latestStatus);
    capabilities.push({
      id: row.scannerKey,
      label: row.scannerKey,
      kind: 'scanner',
      state,
      lastSuccessAt: successAt ? successAt.toISOString() : null,
      latestRunId: row.latestId ?? null,
      // Only from a SUCCESSFUL run. A ref from a failed run would describe a
      // measurement that did not happen.
      lastSuccessRef: row.lastSuccessRef ?? null,
      stale: isStale(successAt, now, freshnessHours),
      detail:
        state === 'failed' && successAt
          ? 'The latest run failed. Earlier findings are still shown and are still real.'
          : state === 'failed'
            ? 'The latest run failed and there is no earlier successful run.'
            : state === 'succeeded'
              ? 'Completed. Zero findings here means a scan ran and found nothing — not that nothing was looked at.'
              : 'A scan is in progress.',
    });
  }

  // The reserved-but-unshipped ones, always, whether or not anything ran.
  for (const [id, detail] of Object.entries(UNSUPPORTED_CAPABILITIES)) {
    if (capabilities.some((c) => c.id === id)) continue;
    capabilities.push({
      id,
      label: id,
      kind: 'scanner',
      state: 'not_supported',
      lastSuccessAt: null,
      latestRunId: null,
      lastSuccessRef: null,
      stale: false,
      detail,
    });
  }

  return {
    repoId,
    checkedAt: now.toISOString(),
    freshnessHours,
    capabilities,
  };
}
