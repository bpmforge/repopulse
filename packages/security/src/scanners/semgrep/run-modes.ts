import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { attachExcerpts } from '../../excerpt.js';
import { persistFindings } from '@repopulse/insights';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { listTreeFiles, shred, snapshotOrProvided } from '../../snapshot/index.js';
import { shadowFindings } from '../../rules/shadow.js';
import {
  fullRunSweep,
  runSemgrepScan,
  SEMGREP_SCANNER_KEY,
  toIncomingFindings,
  type SemgrepRunArgs,
  type SemgrepRunResult,
} from './scanner.js';

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
  /** Defaults to runSemgrepScan; a test seam like the code-health scanners' runPack. */
  runScan?: (args: SemgrepRunArgs) => Promise<SemgrepRunResult>;
  /** W23-02. A tree the scan batch already fetched; absent = fetch our own. */
  snapshot?: { dir: string; commitSha: string };
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
 * The snapshot is bracketed by snapshotForScan (or by the batch that handed one in), so the source is deleted on
 * every exit path including a throw — a scan that crashes must not be the
 * reason a customer's code stays on disk.
 */
export async function runSemgrepFull(
  deps: SemgrepModeDeps & { trigger?: 'schedule' | 'manual' },
): Promise<SemgrepModeResult> {
  const runId = await openRun(deps, deps.trigger ?? 'schedule');
  try {
    return await snapshotOrProvided(
      deps.snapshot,
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const scan = await (deps.runScan ?? runSemgrepScan)({
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

        // Candidate rules land in shadow; deprecated ones are dropped here
        // rather than at the engine, so the pack mounted into the sandbox
        // stays one immutable asset for every workspace.
        const findings = toIncomingFindings(
          await shadowFindings(deps.db, deps.workspaceId, scan.findings),
        );
        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings: await attachExcerpts(snapshot.dir, findings),
          // A FULL run has seen the whole tree, so it may close what it no
          // longer reports — but only its own findings. Scoping this to the
          // scanner is what stops a semgrep run resolving a secrets finding.
          // W20-08 (UX_TODO FND-48): every file the engine read counts as
          // reviewed, not just the ones that still had findings.
          ...fullRunSweep(
            scan,
            findings.map((f) => f.file),
            listTreeFiles(snapshot.dir),
          ),
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

// Every language the shipped packs have rules for. Semgrep itself routes rules
// by extension, so a file here with no rules costs a parse and nothing more —
// but a language missing here means its rules never run on a PR at all.
const SCANNABLE =
  /\.(js|jsx|ts|tsx|mjs|cjs|c|cc|cpp|cxx|h|hh|hpp|hxx|go|py|rs|java|kt|kts|cs|php|rb|swift|scala)$/;

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
  deps: SemgrepModeDeps & {
    prNumber: number;
    maxFiles?: number;
    /**
     * W21-02. The PR's changed files, already copied out of the ONE snapshot the
     * PR scan fetched for this head (scanners/pr/run.ts). With it, this run makes
     * no forge call at all: no file listing and no per-file content fetch, so
     * every pattern scanner on a PR push shares one tarball. The directory
     * belongs to the caller, which deletes it.
     */
    scoped?: { dir: string; paths: readonly string[] };
  },
): Promise<SemgrepModeResult> {
  const runId = await openRun(deps, 'pr_synced');
  const maxFiles = deps.maxFiles ?? 200;
  const ctx: CallCtx = { lane: 'scan', repoId: String(deps.repoId) };
  const root = deps.scoped?.dir ?? (await mkdtemp(path.join(tmpdir(), 'repopulse-semgrep-')));
  const runScan = deps.runScan ?? runSemgrepScan;

  try {
    const changed: string[] = [];
    if (deps.scoped) {
      changed.push(...deps.scoped.paths.filter((p) => SCANNABLE.test(p)));
    } else {
      let cursor: string | undefined;
      do {
        const page = await deps.provider.getPullRequestFiles(ctx, deps.repo, deps.prNumber, cursor);
        changed.push(...page.items.map((f) => f.path).filter((p) => SCANNABLE.test(p)));
        cursor = page.nextCursor;
      } while (cursor !== undefined && changed.length < maxFiles);
    }

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

    let written = deps.scoped ? Math.min(changed.length, maxFiles) : 0;
    for (const file of deps.scoped ? [] : changed.slice(0, maxFiles)) {
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

    const scan = await runScan({
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

    const findings = toIncomingFindings(
      await shadowFindings(deps.db, deps.workspaceId, scan.findings),
    );
    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: null,
      tier: 1,
      findings: await attachExcerpts(root, findings),
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
    // Same discipline as a snapshot: these are the same customer bytes. A
    // scoped directory is the caller's, and the caller shreds it.
    if (!deps.scoped) await shred(root);
  }
}
