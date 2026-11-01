import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, ne } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { toolVersionsEqual } from './up-to-date.js';

// Input-hash gates (W23-04, INCREMENTAL_SCAN_PLAN WP-R4, §3 rows R6/R7/R11).
//
// The whole-tree scanners (dependency CVE, container image, architecture) read
// a tarball and answer a question about a SMALL set of inputs: the manifests,
// the Dockerfiles, the tree itself. When those inputs are byte-identical to the
// ones an earlier run answered, a new commit does not change the answer, and
// fetching the archive to rediscover that is the cost this file removes.
//
// WHAT A GATE MAY SAY. It may say "the same" only when it has read every input
// it hashes. A file the forge truncated, an error that is not a 404, a path
// list nobody recorded: each answers null here, and the caller runs the scan.
// The failure direction is always a redundant scan, never a stale answer.
//
// WHERE THE HASH LIVES. scan_runs has no input-hash column (a migration is not
// in this ticket's scope), so the hash and the path list it covered ride in
// `tool_versions` under two reserved keys. They are stripped from every label
// built from tool versions (`toolLabel`). A dedicated column is the clean home
// and is noted in the ticket report.
//
// The framework never branches on a scanner key: callers pass the key as data.

export const INPUT_HASH_KEY = 'input_hash';
export const INPUT_PATHS_KEY = 'input_paths';
/**
 * A path list longer than this is not stamped; the next run then re-scans. The
 * gate costs one contents-API call per path, so a very wide monorepo is better
 * served by the tarball it already pays for.
 */
const MAX_STAMPED_PATHS = 100;
const MAX_STAMPED_PATHS_CHARS = 8000;

/** Manifests and lockfiles at the repository root — the floor of the known set. */
export const MANIFEST_ROOT_PATHS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'requirements.txt',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'pyproject.toml',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle.lockfile',
];

/** Dockerfiles, compose files and .dockerignore at the root (image gate floor). */
export const IMAGE_ROOT_PATHS: readonly string[] = [
  'Dockerfile',
  'Containerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.dockerignore',
];

const SCAN_CTX: CallCtx = { lane: 'scan' };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Union of path lists, normalised (no leading slash), de-duplicated and sorted. */
export function mergePaths(...lists: ReadonlyArray<readonly string[]>): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const p of list) out.add(p.replace(/^\/+/, ''));
  return [...out].filter((p) => p !== '').sort();
}

/**
 * The hash of a set of files. A path with no file hashes as absent, so adding
 * or deleting a manifest changes the hash like editing one does. Order and
 * duplicates do not matter.
 */
export function hashFileSet(
  files: ReadonlyArray<{ path: string; content: string | null }>,
): string {
  const lines = [...new Map(files.map((f) => [f.path, f])).values()]
    .map((f) => `${f.path}\0${f.content === null ? '-' : sha256(f.content)}`)
    .sort();
  return sha256(lines.join('\n'));
}

/** Reads one path; null = it does not exist at that ref. Throws on anything else. */
export type FileReader = (path: string) => Promise<{ content: string | null } | null>;

export interface FileSetRead {
  /** null when any file could not be read in full — the caller must not skip on it. */
  hash: string | null;
  /** The files that exist, with content, for callers that need to use them. */
  files: { path: string; content: string }[];
  paths: string[];
}

/**
 * Generic: hash `paths` through `read`. A missing file is recorded as absent; a
 * file present but without content (truncated over 1 MB, binary) makes the
 * whole hash null.
 */
export async function fileSetHash(
  read: FileReader,
  paths: readonly string[],
): Promise<FileSetRead> {
  const wanted = mergePaths(paths);
  const seen: { path: string; content: string | null }[] = [];
  const files: { path: string; content: string }[] = [];
  let complete = true;
  for (const p of wanted) {
    const got = await read(p);
    if (got === null) {
      seen.push({ path: p, content: null });
      continue;
    }
    if (got.content === null) {
      complete = false;
      continue;
    }
    seen.push({ path: p, content: got.content });
    files.push({ path: p, content: got.content });
  }
  return { hash: complete ? hashFileSet(seen) : null, files, paths: wanted };
}

/** A forge 404, without importing the class (duck-typed on the status). */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * The files of `paths` at `sha`, through the BUDGETED client's contents API on
 * the `scan` lane (Law 7) — never a raw fetch, never the tarball. One call per
 * path, so the caller keeps the list to the known manifest set.
 */
export async function readManifestSet(
  provider: ForgeProvider,
  repo: string,
  sha: string,
  paths: readonly string[],
): Promise<FileSetRead> {
  return fileSetHash(async (p) => {
    try {
      const got = await provider.getFileContent(SCAN_CTX, repo, p, sha);
      return { content: got.content };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }, paths);
}

/** `manifestSetHash(provider, repo, sha, paths[])` — the hash alone. */
export async function manifestSetHash(
  provider: ForgeProvider,
  repo: string,
  sha: string,
  paths: readonly string[],
): Promise<string | null> {
  return (await readManifestSet(provider, repo, sha, paths)).hash;
}

/** Same hash over files already on disk in a snapshot (a full run stamps with this, no extra calls). */
export function hashSnapshotFiles(dir: string, paths: readonly string[]): FileSetRead {
  const wanted = mergePaths(paths);
  const seen: { path: string; content: string | null }[] = [];
  const files: { path: string; content: string }[] = [];
  let complete = true;
  for (const p of wanted) {
    const full = path.join(dir, p);
    if (!existsSync(full)) {
      seen.push({ path: p, content: null });
      continue;
    }
    try {
      const content = readFileSync(full, 'utf8');
      seen.push({ path: p, content });
      files.push({ path: p, content });
    } catch {
      complete = false;
    }
  }
  return { hash: complete ? hashFileSet(seen) : null, files, paths: wanted };
}

// ---- the advisory data stamp ------------------------------------------------
//
// There is ONE notion of "the data version": the W23-09 stamps, which the
// runners write to `scan_runs.data_version` — `dependencyDataVersion`
// (scanners/dependency/data-stamp.ts) and `imageDataVersion`
// (scanners/image/run.ts). The W23-04 gates compare `data_version` with those
// same functions; the W23-04 `advisoryDataVersion` (vuln-db.version file reader)
// was removed in the merge. deploy/scan-db-sync.sh still writes vuln-db.version
// as an operator-readable record of the last sync; no code reads it.

// ---- the stamp on a run row ------------------------------------------------

/** tool_versions with the input hash (and the paths it covered) added. */
export function stampInputs(
  toolVersions: Record<string, string> | null,
  hash: string | null,
  paths: readonly string[],
): Record<string, string> | null {
  if (hash === null || paths.length > MAX_STAMPED_PATHS) return toolVersions;
  const joined = JSON.stringify(paths);
  if (joined.length > MAX_STAMPED_PATHS_CHARS) return toolVersions;
  return { ...(toolVersions ?? {}), [INPUT_HASH_KEY]: hash, [INPUT_PATHS_KEY]: joined };
}

/** tool_versions without the reserved input keys: what a human or a label should see. */
export function realToolVersions(
  toolVersions: Record<string, string> | null,
): Record<string, string> | null {
  if (toolVersions === null) return null;
  return Object.fromEntries(
    Object.entries(toolVersions).filter(([k]) => k !== INPUT_HASH_KEY && k !== INPUT_PATHS_KEY),
  );
}

/** `grype@0.117 syft@1.5` — the scanner_version label, never carrying the input stamp. */
export function toolLabel(toolVersions: Record<string, string> | null): string {
  return Object.entries(realToolVersions(toolVersions) ?? {})
    .map(([k, v]) => `${k}@${v}`)
    .join(' ');
}

// ---- the baseline ----------------------------------------------------------

/** The earlier real run a gate compares against. */
export interface BaseRun {
  id: number;
  commitSha: string;
  scope: string;
  findingCount: number;
  toolVersions: Record<string, string> | null;
  dataVersion: string | null;
  /** The input hash the run stamped, or null (a run from before the gate). */
  inputHash: string | null;
  /** The paths that hash covered. */
  inputPaths: string[];
}

const BASE_CANDIDATES = 10;

/**
 * The newest real run for (workspace, repo, scanner): succeeded, not partial,
 * not a `skipped` restatement (it stands on a real run; chaining would let an
 * answer outlive its evidence), not a PR look. An `incremental` rematch IS real.
 * Tenancy is re-applied in memory as in `isUpToDate`.
 */
export async function latestBaseRun(
  db: Database,
  q: { workspaceId: number; repoId: number; scannerKey: string },
): Promise<BaseRun | null> {
  const rows = await db
    .select({
      id: security.scanRuns.id,
      workspaceId: security.scanRuns.workspaceId,
      repoId: security.scanRuns.repoId,
      scannerKey: security.scanRuns.scannerKey,
      commitSha: security.scanRuns.commitSha,
      status: security.scanRuns.status,
      partial: security.scanRuns.partial,
      scope: security.scanRuns.scope,
      trigger: security.scanRuns.trigger,
      findingCount: security.scanRuns.findingCount,
      toolVersions: security.scanRuns.toolVersions,
      dataVersion: security.scanRuns.dataVersion,
    })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, q.workspaceId),
        eq(security.scanRuns.repoId, q.repoId),
        eq(security.scanRuns.scannerKey, q.scannerKey),
        eq(security.scanRuns.status, 'succeeded'),
        eq(security.scanRuns.partial, false),
        ne(security.scanRuns.scope, 'skipped'),
        ne(security.scanRuns.trigger, 'pr_synced'),
      ),
    )
    .orderBy(desc(security.scanRuns.id))
    .limit(BASE_CANDIDATES);

  for (const row of rows) {
    if (row.workspaceId !== q.workspaceId || row.repoId !== q.repoId) continue;
    if (row.scannerKey !== q.scannerKey) continue;
    if (row.status !== 'succeeded' || row.partial) continue;
    if (row.scope === 'skipped' || row.trigger === 'pr_synced') continue;
    const tv = row.toolVersions;
    let inputPaths: string[] = [];
    try {
      const parsed: unknown = JSON.parse(tv?.[INPUT_PATHS_KEY] ?? '[]');
      if (Array.isArray(parsed)) {
        inputPaths = parsed.filter((p): p is string => typeof p === 'string');
      }
    } catch {
      inputPaths = [];
    }
    return {
      id: row.id,
      commitSha: row.commitSha,
      scope: row.scope,
      findingCount: row.findingCount,
      toolVersions: tv,
      dataVersion: row.dataVersion,
      inputHash: tv?.[INPUT_HASH_KEY] ?? null,
      inputPaths,
    };
  }
  return null;
}

/** Tool versions equal ignoring the reserved keys; an omitted `expected` skips the comparison. */
export function toolsMatch(
  base: BaseRun,
  expected: Record<string, string> | null | undefined,
): boolean {
  if (expected === undefined) return true;
  return toolVersionsEqual(realToolVersions(base.toolVersions), expected);
}

// ---- recording a gated run ---------------------------------------------------

export const UP_TO_DATE_NOTE =
  'Nothing this scanner reads changed since the last successful run (inputs and data versions are identical), so nothing was re-scanned. Use "Full rescan" to force it.';

export interface GatedRunArgs {
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  commitSha: string;
  trigger: 'schedule' | 'manual' | 'push' | 'pr_synced';
  base: BaseRun;
  scope: 'skipped' | 'incremental';
  /** The data stamp this run is stamped with. */
  dataVersion: string | null;
  findingCount: number;
  note?: string | null;
}

/**
 * Writes the row for a run that read no source: `skipped` restates `base`;
 * `incremental` is a rematch against fresh data. Both are real succeeded rows
 * at the REAL commit that point at the baseline, and both carry the input stamp
 * forward so the next gate has something to compare.
 */
export async function recordGatedRun(db: Database, a: GatedRunArgs): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(security.scanRuns)
    .values({
      workspaceId: a.workspaceId,
      repoId: a.repoId,
      scannerKey: a.scannerKey,
      scannerVersion: toolLabel(a.base.toolVersions) || 'unknown',
      commitSha: a.commitSha,
      trigger: a.trigger,
      status: 'succeeded',
      scope: a.scope,
      baseRunId: a.base.id,
      findingCount: a.findingCount,
      toolVersions: a.base.toolVersions,
      dataVersion: a.dataVersion,
      startedAt: now,
      finishedAt: now,
      error: a.note ?? null,
    })
    .returning({ id: security.scanRuns.id });
  return row!.id;
}

// ---- the commit tree ----------------------------------------------------------

/**
 * The forge port's optional op for a commit's tree sha. NOT on ForgeProvider
 * yet: packages/forge is outside W23-04's write scope. Until the port gains it
 * (GitHub: GET /repos/{repo}/git/commits/{sha} -> tree.sha; Gitea the same;
 * GitLab: the commit's tree via repository/tree), `commitTreeSha` answers null
 * and the architecture gate always runs — the safe default.
 */
export interface TreeShaProvider {
  getCommitTreeSha?(ctx: CallCtx, repo: string, sha: string): Promise<string | null>;
}

export async function commitTreeSha(
  provider: ForgeProvider,
  repo: string,
  sha: string,
): Promise<string | null> {
  const op = (provider as unknown as TreeShaProvider).getCommitTreeSha;
  if (typeof op !== 'function') return null;
  const tree = await op.call(provider, SCAN_CTX, repo, sha);
  return tree === null || tree === '' ? null : tree;
}
