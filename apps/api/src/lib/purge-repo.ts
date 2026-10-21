import { and, eq, inArray, sql } from 'drizzle-orm';
import { core, facts, plans, read, security, type Database } from '@repopulse/shared';

// Purge one repository's stored history (W20-19, UX_TODO INS-09; decision
// 2026-10-20: admins only, behind a typed confirmation, Pause stays the
// default action).
//
// Every row below is deleted by repo_id AND workspace_id (Law 5), in an order
// that satisfies the foreign keys (most of them NO ACTION, chosen in W16-59 so
// that nothing disappears by cascade by accident). The lists at the bottom are
// what the coverage test checks against information_schema: a new table with
// a repo_id column fails that test until it is handled here or named as kept.
//
// What is NOT deleted, and why:
//  - egress_audit: append-only by design (NFR-9, SC-15; the app role has no
//    DELETE on it). A repository whose code was ever sent to an off-network
//    model cannot be purged; the route refuses and says why, and Pause remains.
//  - audit_events: the record of who did what, including this purge.
//  - reports: workspace documents that may name the repository; an admin
//    deletes those one by one (ADM-72).
//  - org-level metric_snapshots (repo_id null): history of the whole
//    workspace. Nothing writes such rows today (every snapshot writer passes a
//    repo id), so none can name this repository; if a rollup writer is added,
//    its rows are workspace history and stay.
//
// forge_etag (W20-22): the cache is keyed by a hash of the request, so its
// rows cannot be matched to a repository by key. Its cached bodies can: every
// row of this connection whose body mentions the repository's org/name is
// deleted. Over-matching (org/name-two) only costs one uncached fetch.

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface PurgeTarget {
  id: number;
  workspaceId: number;
  connectionId: number;
  org: string;
  name: string;
}

export interface PurgeCounts {
  /** Rows deleted per table, only tables that had any. */
  deleted: Record<string, number>;
  /** Agreements, plans and CI tokens that named several repositories: this one taken out. */
  narrowed: Record<string, number>;
  /** CI tokens that read only this repository, revoked rather than widened. */
  ciTokensRevoked: number;
}

/** Tables with a repo_id / repo_ids column that purgeRepoHistory handles. */
export const PURGED_REPO_TABLES = [
  'verified_patches',
  'findings',
  'ai_pass_runs',
  'ai_pass_schedules',
  'analysis_runs',
  'scan_runs',
  'sboms',
  'vex_statements',
  'repo_scanner_config',
  'file_intents',
  'pr_review_comments',
  'pr_reviews',
  'pr_files',
  'check_runs',
  'pull_requests',
  'commit_files',
  'commits',
  'deployments',
  'releases',
  'issues',
  'metric_snapshots',
  'sync_cursors',
  'agreements',
  'improvement_plans',
  'ci_tokens',
] as const;

/** Tables with a repo_id column that a purge deliberately keeps (see above). */
export const KEPT_REPO_TABLES = ['egress_audit'] as const;

/** How many append-only egress records name this repository (a purge refuses when > 0). */
export async function egressRecordCount(db: Database, target: PurgeTarget): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(read.egressAudit)
    .where(
      and(
        eq(read.egressAudit.workspaceId, target.workspaceId),
        eq(read.egressAudit.repoId, target.id),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Delete everything stored about one repository, then the repository row.
 * Runs inside the caller's transaction so a failure part-way leaves it whole.
 */
export async function purgeRepoHistory(
  tx: Tx,
  target: PurgeTarget,
  actorUserId: number,
): Promise<PurgeCounts> {
  const ws = target.workspaceId;
  const deleted: Record<string, number> = {};
  const narrowed: Record<string, number> = {};
  const note = (bucket: Record<string, number>, table: string, n: number) => {
    if (n > 0) bucket[table] = (bucket[table] ?? 0) + n;
  };

  // Findings first: everything about them hangs off their ids.
  const findingIds = (
    await tx
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, ws), eq(read.findings.repoId, target.id)))
  ).map((r) => r.id);
  if (findingIds.length > 0) {
    const ev = await tx
      .delete(read.findingEvents)
      .where(
        and(
          eq(read.findingEvents.workspaceId, ws),
          inArray(read.findingEvents.findingId, findingIds),
        ),
      )
      .returning({ id: read.findingEvents.id });
    note(deleted, 'finding_events', ev.length);
  }

  // One delete per table, by repo and workspace. Order matters: children of a
  // NO ACTION foreign key go before their parents.
  const byRepo: [string, Parameters<Tx['delete']>[0]][] = [
    ['verified_patches', read.verifiedPatches],
    // ai_finding_provenance and ai_triage_verdicts cascade from these two.
    ['findings', read.findings],
    ['ai_pass_runs', read.aiPassRuns],
    ['ai_pass_schedules', read.aiPassSchedules],
    ['analysis_runs', read.analysisRuns],
    ['scan_runs', security.scanRuns],
    ['sboms', security.sboms],
    ['vex_statements', security.vexStatements],
    ['repo_scanner_config', security.repoScannerConfig],
    ['file_intents', plans.fileIntents],
    ['pr_review_comments', facts.prReviewComments],
    ['pr_reviews', facts.prReviews],
    ['pr_files', facts.prFiles],
    ['check_runs', facts.checkRuns],
    ['pull_requests', facts.pullRequests],
    ['commit_files', facts.commitFiles],
    ['commits', facts.commits],
    ['deployments', facts.deployments],
    ['releases', facts.releases],
    ['issues', facts.issues],
    ['metric_snapshots', read.metricSnapshots],
    ['sync_cursors', core.syncCursors],
  ];
  for (const [name, table] of byRepo) {
    // Every one of these tables has workspace_id and repo_id columns.
    const t = table as unknown as {
      workspaceId: typeof facts.commits.workspaceId;
      repoId: typeof facts.commits.repoId;
    };
    const rows = await tx
      .delete(table)
      .where(and(eq(t.workspaceId, ws), eq(t.repoId, target.id)))
      .returning({ one: sql<number>`1` });
    note(deleted, name, rows.length);
  }

  // Not keyed by repo_id, but about this repository only.
  const deliveries = await tx
    .delete(core.webhookDelivery)
    .where(
      and(
        eq(core.webhookDelivery.workspaceId, ws),
        eq(core.webhookDelivery.connectionId, target.connectionId),
        eq(core.webhookDelivery.repoFullName, `${target.org}/${target.name}`),
      ),
    )
    .returning({ id: core.webhookDelivery.id });
  note(deleted, 'webhook_delivery', deliveries.length);
  const failures = await tx
    .delete(core.jobFailure)
    .where(
      and(
        eq(core.jobFailure.workspaceId, ws),
        sql`${core.jobFailure.payload}->>'repoId' = ${String(target.id)}`,
      ),
    )
    .returning({ id: core.jobFailure.id });
  note(deleted, 'job_failure', failures.length);
  // Cached forge responses about this repository (see the header).
  const etags = await tx
    .delete(core.forgeEtag)
    .where(
      and(
        eq(core.forgeEtag.workspaceId, ws),
        eq(core.forgeEtag.connectionId, target.connectionId),
        sql`strpos(${core.forgeEtag.cachedBody}::text, ${`${target.org}/${target.name}`}) > 0`,
      ),
    )
    .returning({ one: sql<number>`1` });
  note(deleted, 'forge_etag', etags.length);

  // Lists of repositories. An EMPTY list means "every repository" for an
  // agreement and a plan, so a list holding only this one is deleted rather
  // than emptied (which would widen it); a CI token's list cannot be empty,
  // so a token for this repository alone is revoked.
  const contains = (col: unknown) => sql`${target.id} = any(${col})`;
  const onlyThis = (col: unknown) => sql`${col} = array[${target.id}]::bigint[]`;

  const soloAgreements = await tx
    .delete(plans.agreements)
    .where(and(eq(plans.agreements.workspaceId, ws), onlyThis(plans.agreements.repoIds)))
    .returning({ id: plans.agreements.id });
  note(deleted, 'agreements', soloAgreements.length);
  const sharedAgreements = await tx
    .update(plans.agreements)
    .set({ repoIds: sql`array_remove(${plans.agreements.repoIds}, ${target.id}::bigint)` })
    .where(and(eq(plans.agreements.workspaceId, ws), contains(plans.agreements.repoIds)))
    .returning({ id: plans.agreements.id });
  note(narrowed, 'agreements', sharedAgreements.length);

  const soloPlans = (
    await tx
      .select({ id: plans.improvementPlans.id })
      .from(plans.improvementPlans)
      .where(
        and(eq(plans.improvementPlans.workspaceId, ws), onlyThis(plans.improvementPlans.repoIds)),
      )
  ).map((r) => r.id);
  if (soloPlans.length > 0) {
    const items = (
      await tx
        .select({ id: plans.planItems.id })
        .from(plans.planItems)
        .where(and(eq(plans.planItems.workspaceId, ws), inArray(plans.planItems.planId, soloPlans)))
    ).map((r) => r.id);
    if (items.length > 0) {
      const ev = await tx
        .delete(plans.planItemEvents)
        .where(
          and(
            eq(plans.planItemEvents.workspaceId, ws),
            inArray(plans.planItemEvents.planItemId, items),
          ),
        )
        .returning({ id: plans.planItemEvents.id });
      note(deleted, 'plan_item_events', ev.length);
      await tx
        .delete(plans.planItems)
        .where(and(eq(plans.planItems.workspaceId, ws), inArray(plans.planItems.id, items)));
      note(deleted, 'plan_items', items.length);
    }
    await tx
      .delete(plans.improvementPlans)
      .where(
        and(
          eq(plans.improvementPlans.workspaceId, ws),
          inArray(plans.improvementPlans.id, soloPlans),
        ),
      );
    note(deleted, 'improvement_plans', soloPlans.length);
  }
  const sharedPlans = await tx
    .update(plans.improvementPlans)
    .set({ repoIds: sql`array_remove(${plans.improvementPlans.repoIds}, ${target.id}::bigint)` })
    .where(
      and(eq(plans.improvementPlans.workspaceId, ws), contains(plans.improvementPlans.repoIds)),
    )
    .returning({ id: plans.improvementPlans.id });
  note(narrowed, 'improvement_plans', sharedPlans.length);

  const revoked = await tx
    .update(core.ciTokens)
    .set({ revokedAt: new Date(), revokedBy: actorUserId })
    .where(
      and(
        eq(core.ciTokens.workspaceId, ws),
        onlyThis(core.ciTokens.repoIds),
        sql`${core.ciTokens.revokedAt} is null`,
      ),
    )
    .returning({ id: core.ciTokens.id });
  const sharedTokens = await tx
    .update(core.ciTokens)
    .set({ repoIds: sql`array_remove(${core.ciTokens.repoIds}, ${target.id}::bigint)` })
    .where(
      and(
        eq(core.ciTokens.workspaceId, ws),
        contains(core.ciTokens.repoIds),
        sql`cardinality(${core.ciTokens.repoIds}) > 1`,
      ),
    )
    .returning({ id: core.ciTokens.id });
  note(narrowed, 'ci_tokens', sharedTokens.length);

  await tx
    .delete(core.repos)
    .where(and(eq(core.repos.id, target.id), eq(core.repos.workspaceId, ws)));
  note(deleted, 'repos', 1);

  return { deleted, narrowed, ciTokensRevoked: revoked.length };
}
