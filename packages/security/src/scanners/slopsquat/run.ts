import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import type { CallCtx, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import { isEnabled } from '../../config/defaults.js';
import { effectiveStatus, registryStatuses } from '../../rules/shadow.js';
import { collectSnapshot, collectTree, FIXTURE_SEGMENT, type CollectedTree } from './collect.js';
import { detectSlopsquats, NEAR_MISS_RULE, SLOPSQUAT_RULE, type DetectResult } from './detect.js';
import { addedFileText, addedLineNumbers } from './diff.js';
import { DECLARING_MANIFEST } from './manifests.js';
import { SLOPSQUAT_ECOSYSTEMS } from './names.js';
import { loadPopular } from './popular.js';
import { loadPackageIndex, packageIndexDir, type PackageIndex } from './registry-index.js';
import { slopFinding, SLOPSQUAT_SCANNER_KEY, SLOPSQUAT_VERSION } from './findings.js';

// The slopsquat scanner, wired to the store (W21-05, FR-SEC-5 step 4).
//
// TWO ENTRY POINTS, ONE SCANNER KEY:
//
//   snapshot mode   runs inside the dependency scan, over the C1a snapshot that
//                   scan already holds: every declaration in every manifest.
//                   Sweeps its own findings on the manifests it read, so a
//                   removed dependency closes by itself.
//   diff mode       rides the secrets stream on pr_synced/push, like the
//                   sensitive-change radar: only manifests the diff touched,
//                   only declarations on ADDED lines. A manifest the change
//                   created is read from its own patch; a modified one is
//                   fetched at the head SHA through the budgeted provider
//                   (getFileContent, `scan` lane, at most MAX_DIFF_MANIFESTS).
//                   No sweep: a diff is not the repository.
//
// NO NETWORK AT SCAN TIME. Registry existence comes from the offline index
// deploy/scan-db-sync.sh syncs beside the vulnerability database; the
// popular-package lists ship with the code. A missing index is a stated
// "not checked" on the run (tool_versions `registry.<eco>`), never a clean
// result, and the near-miss half still runs without it.

export const MAX_DIFF_MANIFESTS = 20;

export interface SlopsquatResult {
  status: 'succeeded' | 'failed' | 'disabled';
  scanRunId: number | null;
  declarations: number;
  signals: number;
  findingsCreated: number;
  /** Ecosystems whose existence half did not run, and why — never silent. */
  notChecked: Record<string, string>;
  error?: string;
}

interface CommonDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** Override for tests; defaults to $SCAN_RULES_DIR/package-index. */
  indexDir?: string;
  now?: Date;
}

export async function slopsquatEnabled(
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
        eq(security.repoScannerConfig.scannerKey, SLOPSQUAT_SCANNER_KEY),
      ),
    );
  return isEnabled(SLOPSQUAT_SCANNER_KEY, row ? { enabled: row.enabled } : undefined);
}

/** Snapshot mode: every manifest in a tree the caller already holds. */
export async function runSlopsquatSnapshotScan(
  deps: CommonDeps & { snapshotDir: string; trigger: 'schedule' | 'manual' | 'push' },
): Promise<SlopsquatResult> {
  return runWith(deps, deps.trigger, null, async () => ({
    tree: collectSnapshot(deps.snapshotDir),
    sweep: true,
  }));
}

/** Diff mode: added declarations in the manifests a PR head or push touched. */
export async function runSlopsquatDiffScan(
  deps: CommonDeps & {
    provider: ForgeProvider;
    repo: string;
    trigger: 'pr_synced' | 'push';
    pullRequestId?: number | null;
    files: readonly ForgeDiffFile[];
  },
): Promise<SlopsquatResult> {
  return runWith(deps, deps.trigger, deps.pullRequestId ?? null, async () => {
    const ctx: CallCtx = { lane: 'scan', repoId: String(deps.repoId) };
    const touched = deps.files.filter(
      (f) =>
        f.status !== 'removed' &&
        DECLARING_MANIFEST.test(path.basename(f.path)) &&
        !FIXTURE_SEGMENT.test(f.path) &&
        f.patch,
    );
    const texts: { path: string; text: string }[] = [];
    const addedLines = new Map<string, Set<number>>();
    for (const file of touched.slice(0, MAX_DIFF_MANIFESTS)) {
      const added = addedLineNumbers(file.patch!);
      if (added.size === 0) continue;
      let text =
        file.status === 'added' && !file.patchTruncated ? addedFileText(file.patch!) : null;
      if (text === null) {
        const content = await deps.provider.getFileContent(
          ctx,
          deps.repo,
          file.path,
          deps.commitSha,
        );
        // Null content: the forge truncated it (>1MB) or it is binary.
        if (content.content === null) continue;
        text = content.content;
      }
      texts.push({ path: file.path, text });
      addedLines.set(file.path, added);
    }
    return { tree: collectTree(texts), sweep: false, addedLines };
  });
}

async function runWith(
  deps: CommonDeps,
  trigger: string,
  pullRequestId: number | null,
  collect: () => Promise<{
    tree: CollectedTree;
    sweep: boolean;
    addedLines?: Map<string, Set<number>>;
  }>,
): Promise<SlopsquatResult> {
  const empty = { declarations: 0, signals: 0, findingsCreated: 0, notChecked: {} };
  if (!(await slopsquatEnabled(deps.db, deps.workspaceId, deps.repoId))) {
    return { status: 'disabled', scanRunId: null, ...empty };
  }
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: SLOPSQUAT_SCANNER_KEY,
      scannerVersion: SLOPSQUAT_VERSION,
      commitSha: deps.commitSha,
      trigger,
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    const { tree, sweep, addedLines } = await collect();
    const indexDir = deps.indexDir ?? packageIndexDir();
    const index = loadPackageIndex(indexDir);
    const detected = detectSlopsquats({
      reads: tree.reads,
      resolved: tree.resolved,
      index,
      popular: loadPopular(indexDir),
      now: deps.now ?? new Date(),
      ownNames: tree.ownNames,
      privateScopes: tree.privateScopes,
      ...(addedLines ? { addedLines } : {}),
    });

    await seedRuleRows(deps.db, deps.workspaceId, [
      ...new Set(detected.signals.map((x) => x.ruleId)),
    ]);
    const statuses = await registryStatuses(deps.db, deps.workspaceId, [
      SLOPSQUAT_RULE,
      NEAR_MISS_RULE,
    ]);
    const findings: IncomingFinding[] = [];
    for (const signal of detected.signals) {
      // Shipped as a candidate: shadow until this workspace promotes it.
      const status = effectiveStatus('candidate', statuses.get(signal.ruleId));
      if (status === 'deprecated') continue;
      findings.push(slopFinding(signal, status !== 'active'));
    }

    const notChecked = notCheckedNotes(detected);
    // A manifest that did not parse was not reviewed: closing its findings
    // because a syntax error hid every declaration would be a false fix.
    const manifests = tree.reads.filter((r) => !r.unparsed).map((r) => r.manifest);
    // The sweep may close a not-in-registry finding only where existence was
    // actually checked this run: with the index gone, not seeing a missing
    // package again is not evidence that it appeared.
    const unchecked = new Set(
      tree.reads
        .filter((r) => r.privateIndex || r.declarations.some((d) => !index.ecosystems[d.ecosystem]))
        .map((r) => r.manifest),
    );
    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId,
      tier: 1,
      findings,
      ...(sweep
        ? {
            reviewedFiles: manifests,
            fullSweep: {
              keepOpen: (row: { ruleId: string | null; file: string | null }) =>
                row.ruleId === SLOPSQUAT_RULE && row.file !== null && unchecked.has(row.file),
            },
          }
        : {}),
      sweepDimensions: ['dependency'],
      sweepScannerKey: SLOPSQUAT_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'succeeded',
        findingCount: findings.length,
        finishedAt: new Date(),
        toolVersions: toolVersions(index, notChecked),
      })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      declarations: detected.declarations,
      signals: detected.signals.length,
      findingsCreated: persisted.created,
      notChecked,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({ status: 'failed', error: safeErrorText(err).slice(0, 500), finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));
    return { status: 'failed', scanRunId: runId, ...empty, error: safeErrorText(err) };
  }
}

/**
 * A candidate registry row for each rule that fired, so Settings → Rules lists
 * it and an admin can promote it behind the usual gate (the code-health
 * adapters' W20-08 pattern). The shadow clock starts at the first finding; an
 * existing row, whatever its status, is never touched.
 */
async function seedRuleRows(
  db: Database,
  workspaceId: number,
  ruleIds: readonly string[],
): Promise<void> {
  if (ruleIds.length === 0) return;
  const now = new Date();
  await db
    .insert(security.ruleRegistry)
    .values(
      ruleIds.map((ruleId) => ({
        workspaceId,
        ruleId,
        status: 'candidate',
        shadowStartedAt: now,
        provenance: {
          source: `scanner:${SLOPSQUAT_SCANNER_KEY}`,
          license: 'UNLICENSED-REPOPULSE',
          author: 'repopulse',
          date: now.toISOString().slice(0, 10),
        },
      })),
    )
    .onConflictDoNothing();
}

function notCheckedNotes(detected: DetectResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [eco, entry] of Object.entries(detected.notChecked)) {
    out[eco] = `${entry.count} not checked: ${entry.reason}`;
  }
  return out;
}

/** What this run could see, per ecosystem, on the scan_run row. */
function toolVersions(
  index: PackageIndex,
  notChecked: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { slopsquat: SLOPSQUAT_VERSION };
  out['package-index'] = index.generated ?? 'absent';
  for (const eco of SLOPSQUAT_ECOSYSTEMS) {
    const idx = index.ecosystems[eco];
    out[`registry.${eco}`] = idx
      ? `${idx.count} names, generated ${idx.generated}`
      : `not checked: ${index.missing[eco] ?? 'no list'}`;
    if (notChecked[eco]) out[`unchecked.${eco}`] = notChecked[eco]!;
  }
  return out;
}
