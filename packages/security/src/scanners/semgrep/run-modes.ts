import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { shred, snapshotForScan } from '../../snapshot/index.js';
import { runSemgrepScan, SEMGREP_SCANNER_KEY, toIncomingFindings } from './scanner.js';

// Full and incremental modes (W8-07, SECURITY_SUITE.md §3.3 / §4).
//
// FULL runs weekly over a snapshot: the whole tree, so a vulnerability that has
// been sitting in a file nobody touched is still found.
// INCREMENTAL runs on pr_synced over the changed files only, fetched
// individually — no tarball, no snapshot. It exists because a week is a long
// time to leave a regression in main, and because a PR-sized scan is cheap
// enough to run on every push.
//
// Both write the SAME finding shape through the SAME store, so a regression
// caught incrementally and then seen again by the weekly full is one finding
// with two sightings, not two findings.

export interface SemgrepModeDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  /** Wall-clock cap for the container (§1.2). */
  wallClockMs?: number;
}

export interface SemgrepModeResult {
  status: 'succeeded' | 'failed' | 'skipped';
  findingsCreated: number;
  findingsTotal: number;
  scanRunId: number | null;
  toolErrors: string[];
  error?: string;
  /** Files a diff-scoped run actually read; null for a full run. */
  filesScanned: number | null;
}

const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

async function openRun(
  deps: SemgrepModeDeps,
  trigger: 'schedule' | 'manual' | 'pr_synced',
): Promise<number> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: SEMGREP_SCANNER_KEY,
      // Filled in properly when the run closes: the engine version is read
      // FROM THE IMAGE rather than assumed, and the image is not consulted
      // until the scan actually runs.
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger,
      status: 'running',
    })
    .returning();
  return run!.id;
}

async function closeRun(
  deps: SemgrepModeDeps,
  runId: number,
  patch: {
    status: 'succeeded' | 'failed';
    findingCount?: number;
    error?: string | null;
    toolVersions?: Record<string, string>;
  },
): Promise<void> {
  await deps.db
    .update(security.scanRuns)
    .set({
      status: patch.status,
      findingCount: patch.findingCount ?? 0,
      error: patch.error ?? null,
      finishedAt: new Date(),
      ...(patch.toolVersions
        ? {
            toolVersions: patch.toolVersions,
            // The one-string column keeps the pair, joined: every screen that
            // shows a version today reads it, and it must not go blank.
            scannerVersion: Object.entries(patch.toolVersions)
              .map(([k, v]) => `${k}@${v}`)
              .join(' '),
          }
        : {}),
    })
    .where(eq(security.scanRuns.id, runId));
}

/**
 * FULL mode: the whole tree at one commit, inside a snapshot (C1a).
 *
 * The snapshot is bracketed by snapshotForScan, so the source is deleted on
 * every exit path including a throw — a scan that crashes must not be the
 * reason a customer's code stays on disk.
 */
export async function runSemgrepFull(
  deps: SemgrepModeDeps & { trigger?: 'schedule' | 'manual' },
): Promise<SemgrepModeResult> {
  const runId = await openRun(deps, deps.trigger ?? 'schedule');
  try {
    return await snapshotForScan(
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const scan = await runSemgrepScan({
          targetDir: snapshot.dir,
          budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
          ...(deps.image ? { image: deps.image } : {}),
        });

        if (scan.status !== 'succeeded') {
          await closeRun(deps, runId, {
            status: 'failed',
            error: scan.error ?? scan.status,
            toolVersions: scan.toolVersions,
          });
          return {
            status: 'failed' as const,
            findingsCreated: 0,
            findingsTotal: 0,
            scanRunId: runId,
            toolErrors: scan.toolErrors,
            ...(scan.error ? { error: scan.error } : {}),
            filesScanned: null,
          };
        }

        const findings = toIncomingFindings(scan.findings);
        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings,
          // A FULL run has seen the whole tree, so it may close what it no
          // longer reports — but only its own findings. Scoping this to the
          // scanner is what stops a semgrep run resolving a secrets finding.
          reviewedFiles: [...new Set(findings.map((f) => f.file).filter((f): f is string => !!f))],
          sweepScannerKey: SEMGREP_SCANNER_KEY,
        });

        await closeRun(deps, runId, {
          status: 'succeeded',
          findingCount: findings.length,
          toolVersions: scan.toolVersions,
        });

        return {
          status: 'succeeded' as const,
          findingsCreated: persisted.created,
          findingsTotal: findings.length,
          scanRunId: runId,
          toolErrors: scan.toolErrors,
          filesScanned: null,
        };
      },
    );
  } catch (err) {
    await closeRun(deps, runId, { status: 'failed', error: safeErrorText(err).slice(0, 500) });
    return {
      status: 'failed',
      findingsCreated: 0,
      findingsTotal: 0,
      scanRunId: runId,
      toolErrors: [],
      error: safeErrorText(err),
      filesScanned: null,
    };
  }
}

const SCANNABLE = /\.(js|jsx|ts|tsx|mjs|cjs|go)$/;

/**
 * INCREMENTAL mode: the files a PR touched, fetched one by one.
 *
 * No tarball and no snapshot — a PR is a handful of files, and pulling a whole
 * archive to scan six of them would spend the forge budget a full run needs.
 * The scratch dir is deleted in a `finally` exactly like a snapshot: the bytes
 * are the same customer source, and where they came from does not change what
 * they are.
 */
export async function runSemgrepIncremental(
  deps: SemgrepModeDeps & { prNumber: number; maxFiles?: number },
): Promise<SemgrepModeResult> {
  const runId = await openRun(deps, 'pr_synced');
  const maxFiles = deps.maxFiles ?? 200;
  const ctx: CallCtx = { lane: 'scan', repoId: String(deps.repoId) };
  const root = await mkdtemp(path.join(tmpdir(), 'repopulse-semgrep-'));

  try {
    const changed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.provider.getPullRequestFiles(ctx, deps.repo, deps.prNumber, cursor);
      changed.push(...page.items.map((f) => f.path).filter((p) => SCANNABLE.test(p)));
      cursor = page.nextCursor;
    } while (cursor !== undefined && changed.length < maxFiles);

    if (changed.length === 0) {
      // Nothing this pack can read. Recorded as a succeeded run with zero
      // findings rather than skipped-with-no-row: "we looked and there was
      // nothing to look at" is a fact the next run needs.
      await closeRun(deps, runId, { status: 'succeeded', findingCount: 0 });
      return {
        status: 'skipped',
        findingsCreated: 0,
        findingsTotal: 0,
        scanRunId: runId,
        toolErrors: [],
        filesScanned: 0,
      };
    }

    let written = 0;
    for (const file of changed.slice(0, maxFiles)) {
      const content = await deps.provider.getFileContent(ctx, deps.repo, file, deps.commitSha);
      // Null content means the forge truncated it (>1MB) or the file is
      // binary. Skipped rather than written empty: an empty file scans clean
      // and would count as coverage it never had.
      if (content.content === null) continue;
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content.content, { mode: 0o600 });
      written += 1;
    }

    const scan = await runSemgrepScan({
      targetDir: root,
      budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
      ...(deps.image ? { image: deps.image } : {}),
    });

    if (scan.status !== 'succeeded') {
      await closeRun(deps, runId, {
        status: 'failed',
        error: scan.error ?? scan.status,
        toolVersions: scan.toolVersions,
      });
      return {
        status: 'failed',
        findingsCreated: 0,
        findingsTotal: 0,
        scanRunId: runId,
        toolErrors: scan.toolErrors,
        ...(scan.error ? { error: scan.error } : {}),
        filesScanned: written,
      };
    }

    const findings = toIncomingFindings(scan.findings);
    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: null,
      tier: 1,
      findings,
      // NO reviewedFiles: a diff-scoped run has seen a handful of files, not
      // the repository, and auto-resolving from a partial view would close
      // findings on files this PR never touched.
      sweepScannerKey: SEMGREP_SCANNER_KEY,
    });

    await closeRun(deps, runId, {
      status: 'succeeded',
      findingCount: findings.length,
      toolVersions: scan.toolVersions,
    });

    return {
      status: 'succeeded',
      findingsCreated: persisted.created,
      findingsTotal: findings.length,
      scanRunId: runId,
      toolErrors: scan.toolErrors,
      filesScanned: written,
    };
  } catch (err) {
    await closeRun(deps, runId, { status: 'failed', error: safeErrorText(err).slice(0, 500) });
    return {
      status: 'failed',
      findingsCreated: 0,
      findingsTotal: 0,
      scanRunId: runId,
      toolErrors: [],
      error: safeErrorText(err),
      filesScanned: null,
    };
  } finally {
    // Same discipline as a snapshot: these are the same customer bytes.
    await shred(root);
  }
}
