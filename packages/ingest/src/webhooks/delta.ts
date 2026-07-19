import { desc, eq } from 'drizzle-orm';
import { facts, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { ingestEntityPages, type PaginatedEntity } from '../backfill/backfill.js';
import type { DeltaJobData, DeltaKind } from './events.js';

// Delta processor (INGESTION §4, FR-INGEST-6): a webhook is a doorbell — this
// re-pulls the affected entity BY CURSOR (high-watermark), not from the
// payload, and upserts idempotently (W2-03), so replaying the same delivery
// twice leaves byte-identical warehouse state.

const KIND_TO_ENTITY: Partial<Record<DeltaKind, PaginatedEntity>> = {
  push_commits: 'commits',
  pull_requests: 'prs',
  issues: 'issues',
  releases: 'releases',
  deployments: 'deployments',
};

// Re-pull slightly before the newest row we have, so an event that lands on the
// boundary is never missed (idempotent upserts make the overlap free).
const DEFAULT_OVERLAP_MS = 60 * 60 * 1000;

async function highWatermark(
  db: Database,
  repoId: number,
  entity: PaginatedEntity,
  overlapMs: number,
): Promise<string | undefined> {
  let latest: Date | null | undefined;
  if (entity === 'commits') {
    const [row] = await db
      .select({ t: facts.commits.committedAt })
      .from(facts.commits)
      .where(eq(facts.commits.repoId, repoId))
      .orderBy(desc(facts.commits.committedAt))
      .limit(1);
    latest = row?.t;
  } else if (entity === 'prs') {
    const [row] = await db
      .select({ t: facts.pullRequests.updatedAt })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.repoId, repoId))
      .orderBy(desc(facts.pullRequests.updatedAt))
      .limit(1);
    latest = row?.t;
  } else if (entity === 'issues') {
    const [row] = await db
      .select({ t: facts.issues.createdAt })
      .from(facts.issues)
      .where(eq(facts.issues.repoId, repoId))
      .orderBy(desc(facts.issues.createdAt))
      .limit(1);
    latest = row?.t;
  }
  // releases/deployments: no reliable updated column — full re-list (cheap, low volume).
  if (!latest) return undefined;
  return new Date(latest.getTime() - overlapMs).toISOString();
}

export interface DeltaDeps {
  db: Database;
  provider: ForgeProvider;
  overlapMs?: number;
  maxPagesPerDelta?: number;
}

export interface DeltaResult {
  kind: DeltaKind;
  skipped?: boolean;
  itemsTotal?: number;
}

/**
 * Process one delta job. Cursor-pullable kinds re-list from the watermark and
 * upsert; checks (per-head-SHA) and repository (auto-add) have no repo-wide
 * cursor list and are documented no-ops here — the nightly sweep (W2-05) and a
 * later checks-by-SHA path cover them.
 */
export async function processDeltaJob(deps: DeltaDeps, data: DeltaJobData): Promise<DeltaResult> {
  const entity = KIND_TO_ENTITY[data.kind];
  if (!entity) return { kind: data.kind, skipped: true };

  const since = await highWatermark(
    deps.db,
    data.repoId,
    entity,
    deps.overlapMs ?? DEFAULT_OVERLAP_MS,
  );
  const result = await ingestEntityPages(
    { db: deps.db, provider: deps.provider, maxPagesPerJob: deps.maxPagesPerDelta ?? 5 },
    {
      workspaceId: data.workspaceId,
      repoId: data.repoId,
      repo: data.repo,
      entityType: entity,
      lane: 'webhook',
      ...(since ? { since } : {}),
    },
  );
  return { kind: data.kind, itemsTotal: result.itemsTotal };
}

// Re-export a narrow helper for tests.
export { highWatermark as _highWatermark };
