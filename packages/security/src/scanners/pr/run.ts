import { copyFile, lstat, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { facts, security, safeErrorText, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import { isEnabled } from '../../config/defaults.js';
import { ECOSYSTEMS } from '../../ecosystems/matrix.js';
import {
  SNAPSHOT_PREFIX,
  readSnapshotSources,
  shred,
  snapshotForScan,
  snapshotRoot,
} from '../../snapshot/index.js';
import { getScanner } from '../../registry.js';
import { ANTI_SLOP_SCANNER_KEY, runAntiSlopScan } from '../anti-slop/run.js';
import { DEPENDENCY_SCANNER_KEY } from '../dependency/findings.js';
import { runDependencyScan } from '../dependency/run.js';
import { IMAGE_SCANNER_KEY } from '../image/findings.js';
import { extractImageRefs, imageSourceKind } from '../image/refs.js';
import { readImageSourceFiles, runImageScan } from '../image/run.js';
import { LOGGING_SCANNER_KEY, runLoggingScan } from '../logging/run.js';
import { PERF_SCANNER_KEY, runPerfScan } from '../perf/run.js';
import { runSemgrepIncremental } from '../semgrep/run-modes.js';
import { SEMGREP_SCANNER_KEY } from '../semgrep/scanner.js';

// The pattern scanners on every pull-request push (W21-02).
//
// Until this, a PR push ran the secrets stream and the sensitive-change radar
// that rides it, and nothing else: SAST, anti-slop, logging, performance and
// dependency scans ran weekly or by hand, so the CI pull (W18-18) had almost
// nothing to report on a change that had just landed.
//
// THE BUDGET RULE. One source archive per PR head, shared by every scanner
// here. The PR's file list is read once (one call per 100 changed files) and
// the tarball once; each scanner reads that one tree, and none of them calls
// the forge itself. A head that already has a pr_synced run from this set is
// not fetched again, so a replayed webhook, a label change or a review on the
// same head costs one database query.
//
// WHAT "SCOPED" MEANS PER SCANNER.
//   - semgrep, logging_hygiene, performance: their packs run over a scratch
//     directory holding ONLY the changed files, copied out of the snapshot.
//   - anti_slop: its whole-tree rules (phantom imports, dead exports) need the
//     whole tree to be right, so it reads the head's tree and keeps only the
//     findings on changed files; its pack runs over the changed files.
//   - dependency_cve: whole-repository, because a lockfile is read whole — and
//     only when the PR changed a manifest or lockfile. Otherwise it does not
//     run on that head at all.
//   - container_image: opt-in (off by default), and only when a changed
//     Dockerfile, compose file or manifest names an image.
// No PR run sweeps (closes) anything: a branch is not the default branch.
// None of these calls a model: the judgement halves stay weekly and in the
// opt-in AI pass, so a push never spends model calls by itself.
//
// ORDER IS PART OF THE CONTRACT with the CI pull (new-findings.ts, X-13). The
// two conditional scanners run FIRST, so by the time the always-run ones have
// finished, a conditional scanner that applies has a run row at the head.
// That is how `head.scanned` can wait for exactly the set that runs here
// without a second record of the plan.

/** The pattern scanners a PR push can run, in the order they run. */
export const PR_PATTERN_SCANNERS = [
  DEPENDENCY_SCANNER_KEY,
  IMAGE_SCANNER_KEY,
  SEMGREP_SCANNER_KEY,
  ANTI_SLOP_SCANNER_KEY,
  LOGGING_SCANNER_KEY,
  PERF_SCANNER_KEY,
] as const;

/**
 * Scanners that run on a PR push only when the change gives them something to
 * read. The CI pull expects one of these at a head only once it has started.
 */
export const PR_CONDITIONAL_SCANNERS: readonly string[] = [
  DEPENDENCY_SCANNER_KEY,
  IMAGE_SCANNER_KEY,
];

/** Heads scanned per delta, newest PRs first. The rest wait for the next one, counted. */
export const PR_SCAN_MAX_TARGETS = 3;

/** Run states after which a head is not fetched again. budget_exceeded is retried. */
const SCANNED_STATES = ['running', 'succeeded', 'failed'] as const;

/** Manifests a dependency scan reads beyond the lockfiles of the measured matrix. */
const MANIFEST_NAMES = new Set([
  'package.json',
  'npm-shrinkwrap.json',
  'pyproject.toml',
  'Pipfile',
  'Pipfile.lock',
  'setup.py',
  'setup.cfg',
  'Gemfile',
  'Cargo.toml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Directory.Packages.props',
  'Package.swift',
  'Podfile',
  'conanfile.py',
  'mix.exs',
  'mix.lock',
  'pubspec.yaml',
  'pubspec.lock',
]);
const LOCKFILE_NAMES = new Set(ECOSYSTEMS.flatMap((e) => e.files));

/** True when a dependency scan has something new to read in this path. */
export function isDependencyManifest(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  return (
    LOCKFILE_NAMES.has(base) ||
    MANIFEST_NAMES.has(base) ||
    /^requirements[\w.-]*\.(txt|in)$/i.test(base) ||
    /\.(csproj|fsproj|vbproj)$/i.test(base)
  );
}

export interface PrScanTarget {
  commitSha: string;
  prNumber: number;
  pullRequestId: number;
}

/** A head counts as scanned once this set has a pr_synced run there (budget parks aside). */
function scannedHeads(db: Database, workspaceId: number, repoId: number) {
  return db
    .select({ sha: security.scanRuns.commitSha })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.trigger, 'pr_synced'),
        inArray(security.scanRuns.scannerKey, [...PR_PATTERN_SCANNERS]),
        inArray(security.scanRuns.status, [...SCANNED_STATES]),
      ),
    );
}

/**
 * Open PR heads this set has not scanned, newest first. Returns up to
 * `limit + 1` rows so a caller can tell "exactly the cap" from "more waiting".
 * Closed and merged PRs are left out: scanning a branch nobody will push again
 * spends a tarball on a question nobody is asking.
 */
export async function pendingPrPatternTargets(
  db: Database,
  workspaceId: number,
  repoId: number,
  limit: number = PR_SCAN_MAX_TARGETS,
): Promise<PrScanTarget[]> {
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
        eq(facts.pullRequests.state, 'open'),
        notInArray(facts.pullRequests.headSha, scannedHeads(db, workspaceId, repoId)),
      ),
    )
    .orderBy(desc(facts.pullRequests.updatedAt))
    .limit(limit + 1);
  return rows.map((r) => ({ commitSha: r.headSha, prNumber: r.number, pullRequestId: r.id }));
}

async function headAlreadyScanned(
  db: Database,
  workspaceId: number,
  repoId: number,
  commitSha: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: security.scanRuns.id })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.commitSha, commitSha),
        eq(security.scanRuns.trigger, 'pr_synced'),
        inArray(security.scanRuns.scannerKey, [...PR_PATTERN_SCANNERS]),
        inArray(security.scanRuns.status, [...SCANNED_STATES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The pattern scanners this repository has on (stored choice first, then the default). */
export async function enabledPrPatternScanners(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({
      scannerKey: security.repoScannerConfig.scannerKey,
      enabled: security.repoScannerConfig.enabled,
    })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, workspaceId),
        eq(security.repoScannerConfig.repoId, repoId),
        inArray(security.repoScannerConfig.scannerKey, [...PR_PATTERN_SCANNERS]),
      ),
    );
  const stored = new Map(rows.map((r) => [r.scannerKey, { enabled: r.enabled }]));
  return new Set(PR_PATTERN_SCANNERS.filter((k) => isEnabled(k, stored.get(k))));
}

/** The scanner functions, injectable so the plan and the budget are testable without a container. */
export interface PrScanRunners {
  semgrep: typeof runSemgrepIncremental;
  antiSlop: typeof runAntiSlopScan;
  logging: typeof runLoggingScan;
  perf: typeof runPerfScan;
  dependency: typeof runDependencyScan;
  image: typeof runImageScan;
}

const DEFAULT_RUNNERS: PrScanRunners = {
  semgrep: runSemgrepIncremental,
  antiSlop: runAntiSlopScan,
  logging: runLoggingScan,
  perf: runPerfScan,
  dependency: runDependencyScan,
  image: runImageScan,
};

export interface PrScanDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  /** owner/name, for the forge calls. */
  repo: string;
  target: PrScanTarget;
  runners?: Partial<PrScanRunners>;
}

export interface PrScanResult {
  commitSha: string;
  /** Why nothing ran, when nothing did. */
  skipped?: 'disabled' | 'already_scanned' | 'nothing_to_run';
  /** Final run status per scanner that ran (or was recorded as unable to). */
  ran: Record<string, string>;
  /** Enabled conditional scanners the change gave nothing to read. */
  notApplicable: string[];
  findingsCreated: number;
  filesChanged: number;
  /** What this head cost the forge budget: file-list pages and archives. */
  forgeCalls: { fileListPages: number; tarballs: number };
  error?: string;
}

/** Written for a scanner that had nothing to read, so the head reads as scanned. */
const NOTHING_TO_SCAN = 'Nothing to scan: the pull request changed no file this scanner reads.';

/**
 * Runs the enabled pattern scanners over ONE pull-request head.
 *
 * Never throws for a scanner-side failure: every outcome lands on a scan_run
 * row, including a source archive that could not be fetched, because the CI
 * pull waits for a row per scanner and a missing one would hold it for good.
 */
export async function runPrPatternScans(deps: PrScanDeps): Promise<PrScanResult> {
  const { db, workspaceId, repoId, target } = deps;
  const runners = { ...DEFAULT_RUNNERS, ...deps.runners };
  const result: PrScanResult = {
    commitSha: target.commitSha,
    ran: {},
    notApplicable: [],
    findingsCreated: 0,
    filesChanged: 0,
    forgeCalls: { fileListPages: 0, tarballs: 0 },
  };

  const enabled = await enabledPrPatternScanners(db, workspaceId, repoId);
  if (enabled.size === 0) return { ...result, skipped: 'disabled' };
  if (await headAlreadyScanned(db, workspaceId, repoId, target.commitSha)) {
    return { ...result, skipped: 'already_scanned' };
  }

  const record = async (
    keys: readonly string[],
    status: 'succeeded' | 'failed' | 'budget_exceeded',
    error: string | null,
  ): Promise<void> => {
    if (keys.length === 0) return;
    const at = new Date();
    await db.insert(security.scanRuns).values(
      keys.map((scannerKey) => ({
        workspaceId,
        repoId,
        scannerKey,
        scannerVersion: getScanner(scannerKey)?.version ?? 'unregistered',
        commitSha: target.commitSha,
        trigger: 'pr_synced',
        status,
        error,
        startedAt: at,
        finishedAt: at,
      })),
    );
    for (const k of keys) result.ran[k] = status;
  };
  const always = PR_PATTERN_SCANNERS.filter(
    (k) => enabled.has(k) && !PR_CONDITIONAL_SCANNERS.includes(k),
  );
  const unreachable = async (err: unknown, planned: readonly string[]) => {
    const parked = err instanceof Error && err.name === 'ForgeBudgetParkedError';
    // A budget park is retried by the next delta; anything else is recorded
    // as failed so the CI pull names it rather than waiting for ever.
    await record(
      planned,
      parked ? 'budget_exceeded' : 'failed',
      parked
        ? 'The forge rate-limit budget for scans is spent, so this head was not fetched. It is retried on the next pull-request event.'
        : `The pull request's files could not be read from the forge: ${safeErrorText(err).slice(0, 400)}`,
    );
    return { ...result, error: safeErrorText(err) };
  };

  // 1. The PR's changed files, once.
  const ctx: CallCtx = { lane: 'scan', repoId: String(repoId) };
  const files: ForgeDiffFile[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await deps.provider.getPullRequestFiles(ctx, deps.repo, target.prNumber, cursor);
      result.forgeCalls.fileListPages += 1;
      files.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (err) {
    return unreachable(err, always);
  }
  const changed = files.filter((f) => f.status !== 'removed');
  result.filesChanged = changed.length;
  const changedPaths = new Set(changed.map((f) => f.path));

  // 2. The plan. A conditional scanner whose file kind did not change is not
  //    run, and gets no row: the CI pull does not wait for it.
  const wantsDependency =
    enabled.has(DEPENDENCY_SCANNER_KEY) && changed.some((f) => isDependencyManifest(f.path));
  const mayWantImage =
    enabled.has(IMAGE_SCANNER_KEY) && changed.some((f) => imageSourceKind(f.path) !== null);
  if (enabled.has(DEPENDENCY_SCANNER_KEY) && !wantsDependency) {
    result.notApplicable.push(DEPENDENCY_SCANNER_KEY);
  }
  if (enabled.has(IMAGE_SCANNER_KEY) && !mayWantImage) result.notApplicable.push(IMAGE_SCANNER_KEY);
  const planned = [
    ...(wantsDependency ? [DEPENDENCY_SCANNER_KEY] : []),
    ...(mayWantImage ? [IMAGE_SCANNER_KEY] : []),
    ...always,
  ];
  if (planned.length === 0) return { ...result, skipped: 'nothing_to_run' };

  if (!deps.provider.capabilities.supportsTarball) {
    await record(
      planned,
      'failed',
      'This forge cannot provide a source archive, so the pattern scanners cannot read the pull request.',
    );
    return result;
  }

  // 3. ONE archive, every scanner.
  let fetched = false;
  try {
    await snapshotForScan(
      { provider: deps.provider, repo: deps.repo, commitSha: target.commitSha },
      async (snapshot) => {
        fetched = true;
        result.forgeCalls.tarballs += 1;
        await scanSnapshot(deps, runners, snapshot, changed, changedPaths, planned, result, record);
      },
    );
  } catch (err) {
    if (!fetched) {
      result.forgeCalls.tarballs += 1;
      return unreachable(err, planned);
    }
    result.error = safeErrorText(err);
  }
  return result;
}

/** The changed files, copied out of the snapshot into a directory of their own. */
async function scopedCopy(
  snapshotDir: string,
  changed: readonly string[],
): Promise<{ dir: string; paths: string[] }> {
  const root = snapshotRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The snapshot prefix, so the orphan sweeper removes it after a SIGKILL too.
  const dir = await mkdtemp(path.join(root, `${SNAPSHOT_PREFIX}pr-`));
  const paths: string[] = [];
  for (const rel of changed) {
    const from = path.resolve(snapshotDir, rel);
    // Never outside the snapshot, whatever the forge called the file.
    if (!from.startsWith(`${path.resolve(snapshotDir)}${path.sep}`)) continue;
    let stats;
    try {
      stats = await lstat(from);
    } catch {
      continue; // not in the archive (a submodule, an LFS pointer the forge left out)
    }
    if (!stats.isFile()) continue; // links and directories are not followed
    const to = path.join(dir, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    paths.push(rel);
  }
  return { dir, paths };
}

async function scanSnapshot(
  deps: PrScanDeps,
  runners: PrScanRunners,
  snapshot: { dir: string; commitSha: string },
  changed: readonly ForgeDiffFile[],
  changedPaths: ReadonlySet<string>,
  planned: readonly string[],
  result: PrScanResult,
  record: (
    keys: readonly string[],
    status: 'succeeded' | 'failed',
    error: string | null,
  ) => Promise<void>,
): Promise<void> {
  const { db, workspaceId, repoId, target } = deps;
  const base = { db, workspaceId, repoId, commitSha: target.commitSha };
  const forge = { ...base, provider: deps.provider, repo: deps.repo };
  const diff = changed.map((f) => ({
    path: f.path,
    patch: f.patch ?? null,
    patchTruncated: f.patchTruncated,
  }));

  // One scanner's failure is its own: recorded on its row, and the rest run.
  const step = async (
    key: string,
    run: () => Promise<{ status: string; findingsCreated?: number }>,
  ): Promise<void> => {
    if (!planned.includes(key)) return;
    try {
      const out = await run();
      result.ran[key] = out.status;
      result.findingsCreated += out.findingsCreated ?? 0;
    } catch (err) {
      await record([key], 'failed', safeErrorText(err).slice(0, 500));
    }
  };

  const scoped = await scopedCopy(
    snapshot.dir,
    changed.map((f) => f.path),
  );
  try {
    // Conditional scanners FIRST (see the header): their rows must exist
    // before the always-run ones finish.
    await step(DEPENDENCY_SCANNER_KEY, () =>
      runners.dependency({
        ...forge,
        trigger: 'pr_synced',
        snapshot,
        pullRequestId: target.pullRequestId,
      }),
    );
    if (planned.includes(IMAGE_SCANNER_KEY)) {
      // Only changed files that actually name an image: the scan pulls what
      // they name, and an unchanged Dockerfile's images are the weekly
      // question, not this change's.
      const imageFiles = (await readImageSourceFiles(snapshot.dir)).filter(
        (f) => changedPaths.has(f.path) && extractImageRefs([f]).images.length > 0,
      );
      if (imageFiles.length === 0) {
        // A changed YAML file that names no image (a CI workflow, say).
        result.notApplicable.push(IMAGE_SCANNER_KEY);
      } else {
        await step(IMAGE_SCANNER_KEY, () =>
          runners.image({
            ...forge,
            trigger: 'pr_synced',
            snapshot,
            pullRequestId: target.pullRequestId,
            files: async () => imageFiles,
          }),
        );
      }
    }

    await step(SEMGREP_SCANNER_KEY, () =>
      runners.semgrep({ ...forge, prNumber: target.prNumber, scoped }),
    );

    await step(ANTI_SLOP_SCANNER_KEY, () => {
      const sources = readSnapshotSources(snapshot.dir);
      return runners.antiSlop({
        ...base,
        files: diff,
        sources: sources.files,
        sourcesComplete: !sources.truncated && sources.skipped === 0,
        snapshotDir: snapshot.dir,
        ...(scoped.paths.length > 0 ? { targetDir: scoped.dir } : {}),
        trigger: 'pr_synced',
        pullRequestId: target.pullRequestId,
      });
    });

    await step(LOGGING_SCANNER_KEY, () =>
      runners.logging({
        ...base,
        files: diff,
        ...(scoped.paths.length > 0 ? { targetDir: scoped.dir } : {}),
        trigger: 'pr_synced',
        pullRequestId: target.pullRequestId,
      }),
    );

    if (planned.includes(PERF_SCANNER_KEY) && scoped.paths.length === 0) {
      await record([PERF_SCANNER_KEY], 'succeeded', NOTHING_TO_SCAN);
    } else {
      await step(PERF_SCANNER_KEY, () =>
        runners.perf({
          ...base,
          targetDir: scoped.dir,
          trigger: 'pr_synced',
          pullRequestId: target.pullRequestId,
        }),
      );
    }
  } finally {
    await shred(scoped.dir);
  }
}
