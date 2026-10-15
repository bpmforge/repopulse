import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { facts, security, type Database } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { CallCtx, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import { isEnabled } from '../../config/defaults.js';
import { buildSecretFindings, SECRETS_SCANNER_KEY } from './scanner.js';
import { loadRulepack } from './rulepack.js';
import type { SecretsVerificationConfig } from './verify.js';
import { runSensitiveChangeScan } from '../sensitive-change/run.js';

// Stream mode (W8-04, SECURITY_SUITE.md 3.1, FR-SEC-3).
//
// This is the half that makes the scanner real: it rides ingestion. A webhook
// delta lands, the warehouse gains a PR head SHA or a commit, and this runs the
// rulepack over that diff — no snapshot, no container, no queue hop.
//
// WHAT TO SCAN IS DERIVED FROM THE WAREHOUSE, NOT FROM THE WEBHOOK PAYLOAD.
// The delta job deliberately carries no PR number (a webhook is a doorbell:
// INGESTION §4), so this asks the same question ingestion does — which head
// SHAs have no succeeded secrets run yet — and answers it idempotently. A
// replayed delivery therefore scans nothing a second time.

export interface StreamScanDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  /** owner/name, for the forge call. */
  repo: string;
  trigger: 'pr_synced' | 'push';
  /** Cap per delta, so a burst cannot spend the forge budget. */
  maxTargets?: number;
  verification?: SecretsVerificationConfig;
}

export interface StreamScanTarget {
  commitSha: string;
  prNumber?: number;
  pullRequestId?: number;
}

export interface StreamScanResult {
  scanned: StreamScanTarget[];
  findingsCreated: number;
  /** Targets left for the next delta because the cap was hit — never silent. */
  deferred: number;
  skipped?: 'disabled' | 'no_targets';
}

/** Head SHAs with no succeeded secrets scan yet, newest PRs first. */
export async function pendingPrTargets(
  db: Database,
  workspaceId: number,
  repoId: number,
  limit: number,
): Promise<StreamScanTarget[]> {
  const scanned = db
    .select({ sha: security.scanRuns.commitSha })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.scannerKey, SECRETS_SCANNER_KEY),
        inArray(security.scanRuns.status, ['succeeded', 'running']),
      ),
    );

  const rows = await db
    .select({
      id: facts.pullRequests.id,
      number: facts.pullRequests.number,
      headSha: facts.pullRequests.headSha,
    })
    .from(facts.pullRequests)
    .where(
      and(
        eq(facts.pullRequests.workspaceId, workspaceId),
        eq(facts.pullRequests.repoId, repoId),
        notInArray(facts.pullRequests.headSha, scanned),
      ),
    )
    .orderBy(desc(facts.pullRequests.updatedAt))
    .limit(limit + 1);

  return rows.map((r) => ({ commitSha: r.headSha, prNumber: r.number, pullRequestId: r.id }));
}

/** Newest commits with no succeeded secrets scan yet (push trigger). */
export async function pendingCommitTargets(
  db: Database,
  workspaceId: number,
  repoId: number,
  limit: number,
): Promise<StreamScanTarget[]> {
  const scanned = db
    .select({ sha: security.scanRuns.commitSha })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.scannerKey, SECRETS_SCANNER_KEY),
        inArray(security.scanRuns.status, ['succeeded', 'running']),
      ),
    );

  const rows = await db
    .select({ sha: facts.commits.sha })
    .from(facts.commits)
    .where(
      and(
        eq(facts.commits.workspaceId, workspaceId),
        eq(facts.commits.repoId, repoId),
        notInArray(facts.commits.sha, scanned),
      ),
    )
    .orderBy(desc(facts.commits.committedAt))
    .limit(limit + 1);

  return rows.map((r) => ({ commitSha: r.sha }));
}

export async function scannerEnabled(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: security.repoScannerConfig.enabled })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, workspaceId),
        eq(security.repoScannerConfig.repoId, repoId),
        eq(security.repoScannerConfig.scannerKey, SECRETS_SCANNER_KEY),
      ),
    );
  // An explicit stored value wins in BOTH directions (W8-01): a repo that
  // opted out must stay out even when the default is on.
  return isEnabled(SECRETS_SCANNER_KEY, row ? { enabled: row.enabled } : undefined);
}

export async function diffOf(
  deps: Pick<StreamScanDeps, 'provider' | 'repo' | 'repoId'>,
  target: StreamScanTarget,
): Promise<ForgeDiffFile[]> {
  // The `scan` lane (W8-03): below a user waiting on a page, above reconcile.
  const ctx: CallCtx = { lane: 'scan', repoId: String(deps.repoId) };
  const files: ForgeDiffFile[] = [];
  let cursor: string | undefined;

  if (target.prNumber !== undefined) {
    do {
      const page = await deps.provider.getPullRequestFiles(ctx, deps.repo, target.prNumber, cursor);
      files.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return files;
  }

  do {
    const page = await deps.provider.getCommitFiles(ctx, deps.repo, target.commitSha, cursor);
    files.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return files;
}

/**
 * Scans every unscanned head SHA for one repo and stores what it finds.
 *
 * Never throws for a scanner-side failure: a secrets scan that blows up must
 * not fail the ingestion job it rides on (NFR-15). The scan_run row carries the
 * failure instead, which is the difference between a scan nobody noticed and a
 * repo whose data stopped updating.
 */
export async function runSecretsStreamScan(deps: StreamScanDeps): Promise<StreamScanResult> {
  if (!(await scannerEnabled(deps.db, deps.workspaceId, deps.repoId))) {
    return { scanned: [], findingsCreated: 0, deferred: 0, skipped: 'disabled' };
  }

  const cap = deps.maxTargets ?? 10;
  const found =
    deps.trigger === 'push'
      ? await pendingCommitTargets(deps.db, deps.workspaceId, deps.repoId, cap)
      : await pendingPrTargets(deps.db, deps.workspaceId, deps.repoId, cap);
  const targets = found.slice(0, cap);
  const deferred = Math.max(0, found.length - targets.length);

  if (targets.length === 0) {
    return { scanned: [], findingsCreated: 0, deferred: 0, skipped: 'no_targets' };
  }

  let findingsCreated = 0;
  const scanned: StreamScanTarget[] = [];

  for (const target of targets) {
    const created = await scanOneTarget(deps, target, deps.trigger === 'push' ? 'push' : 'pr_synced');
    if (created !== null) {
      findingsCreated += created;
      scanned.push(target);
    }
  }

  return { scanned, findingsCreated, deferred };
}

/** Count of secrets findings for a repo — used by tests and the Security tab. */
export async function secretsFindingCount(db: Database, repoId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.scannerKey, SECRETS_SCANNER_KEY),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Scans ONE commit/PR head and stores what it finds. Returns the number of new
 * findings, or null when the scan failed.
 *
 * Shared by stream mode and history mode (W8-05) rather than copied: the two
 * differ in WHICH SHAs they pick, and nothing else. A second copy of the
 * redaction-and-persist path is a second place for SC-29 to be got wrong.
 *
 * Never throws for a scanner-side failure: a secrets scan that blows up must
 * not fail the ingestion job it rides on (NFR-15). The scan_run row carries the
 * failure instead, which is the difference between a scan nobody noticed and a
 * repo whose data stopped updating.
 */
export async function scanOneTarget(
  deps: Pick<StreamScanDeps, 'db' | 'provider' | 'repo' | 'repoId' | 'workspaceId' | 'verification'>,
  target: StreamScanTarget,
  trigger: 'pr_synced' | 'push' | 'schedule' | 'manual',
): Promise<number | null> {
  const pack = loadRulepack();
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: SECRETS_SCANNER_KEY,
      // The RULEPACK version, not a package version: the pack is what decides
      // whether something is a secret, so it is what a finding has to be
      // reproducible against.
      scannerVersion: pack.versionTag,
      commitSha: target.commitSha,
      trigger,
      status: 'running',
    })
    .returning();

  try {
    const files = await diffOf(deps, target);
    const findings = buildSecretFindings({
      files: files.map((f) => ({ path: f.path, patch: f.patch ?? null })),
      rulepack: pack,
      ...(deps.verification ? { verification: deps.verification } : {}),
    });

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: run!.id,
      pullRequestId: target.pullRequestId ?? null,
      // Tier 1: no LLM was involved. A regex pass claiming tier 2 would put
      // deterministic findings in the same bucket as model output.
      tier: 1,
      findings,
      // NO reviewedFiles on purpose: a diff is not the repository. Auto-
      // resolving "everything I did not see" from a partial view would close
      // findings on files this commit simply did not touch.
      sweepScannerKey: SECRETS_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, run!.id));

    // W18-21: the sensitive-change radar reads the SAME diff, so it costs no
    // second fetch. Arrivals only — history mode sweeps months-old commits,
    // and asking a person to review a year-old change helps nobody. Its own
    // scan_run, its own enablement, and its failures stay its own: the
    // secrets result above is already stored and is returned regardless.
    if (trigger === 'pr_synced' || trigger === 'push') {
      try {
        await runSensitiveChangeScan({
          db: deps.db,
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          commitSha: target.commitSha,
          trigger,
          pullRequestId: target.pullRequestId ?? null,
          files,
        });
      } catch {
        // Enablement lookup or run-row insert failed before the radar could
        // record anything. Swallowed so the secrets run keeps its result.
      }
    }
    return persisted.created;
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: (err as Error).message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, run!.id));
    return null;
  }
}
