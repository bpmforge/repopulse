import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/index.js';
import {
  IMAGE_ROOT_PATHS,
  advisoryDataVersion,
  hashFileSet,
  hashSnapshotFiles,
  mergePaths,
  readManifestSet,
  recordGatedRun,
  stampInputs,
  toolLabel,
  toolsMatch,
  UP_TO_DATE_NOTE,
  type BaseRun,
} from '../../framework/input-hash.js';
import type { DependencyMatch } from '../dependency/matches.js';
import { vulnDbDir } from '../dependency/tools.js';
import { imageFinding, IMAGE_SCANNER_KEY, type PricedImageFinding } from './findings.js';
import { listTags, pullImage, type PullResult } from './pull.js';
import { distinctImages, extractImageRefs, imageSourceKind, type ImageRef } from './refs.js';
import { scanImageArchive, type ImageScanResult } from './scan.js';
import { upgradeCandidates, upgradeSuggestion, type CandidateScan } from './upgrade.js';

// The container image scanner, end to end (W18-34, D8 / C1a).
//
// OFF BY DEFAULT and opt-in per repository (Brad, 2026-10-16): it makes outbound
// registry pulls, and for private images it uses credentials the self-hoster
// supplies (IMAGE_SCAN_AUTH_FILE). Images named in Dockerfiles, compose files
// and Kubernetes manifests are pulled host-side into scratch, scanned with grype
// in the network-less sandbox, and deleted. Nothing but findings is kept.

export interface ImageRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  vulnDb?: string;
  trigger?: 'schedule' | 'manual' | 'push' | 'pr_synced';
  wallClockMs?: number;
  /**
   * W21-02. The PR scan's one snapshot of a pull request's head, shared by every
   * pattern scanner; absent = fetch one. A `pr_synced` run closes nothing (a
   * branch is not the default branch) and stamps the PR on what it creates.
   */
  snapshot?: { dir: string; commitSha: string };
  pullRequestId?: number | null;
  /**
   * W23-04. The newest real run for this repo (`latestBaseRun`). When given, the
   * run first asks `imageScanDecision` and records a `skipped` row instead of
   * pulling anything when the inputs and the data are unchanged. Omit to force.
   */
  baseRun?: BaseRun | null | undefined;
  /**
   * W23-04. Digests of the base images, where the caller knows them (a registry
   * HEAD per tag). Folded into the input hash, so a moved `node:20` re-scans.
   * Absent = digests unknown; see `imageScanDecision` for what that means.
   */
  imageDigests?: () => Promise<string[] | null>;
  /** Most distinct images scanned per run. */
  maxImages?: number;
  /** Newer tags tried per image when looking for an upgrade that clears findings. */
  maxCandidates?: number;
  /** Test seams; production uses skopeo and the sandbox. */
  pull?: (ref: string, dir: string) => Promise<PullResult>;
  scan?: (dir: string) => Promise<ImageScanResult>;
  tags?: (image: ImageRef) => Promise<string[] | null>;
  files?: (dir: string) => Promise<{ path: string; content: string }[]>;
}

export interface ImageRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  imagesNamed: number;
  imagesScanned: number;
  imagesFailed: { ref: string; reason: string }[];
  imagesSkipped: number;
  imagesOverCap: number;
  findingsCreated: number;
  findingsTotal: number;
  /** W23-04: which way the input-hash gate went. Absent = no baseline was offered. */
  gate?: ImageScanDecision;
  error?: string;
}

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;
const MAX_FILES = 400;

const empty = {
  imagesNamed: 0,
  imagesScanned: 0,
  imagesFailed: [] as { ref: string; reason: string }[],
  imagesSkipped: 0,
  imagesOverCap: 0,
  findingsCreated: 0,
  findingsTotal: 0,
};

/** Dockerfiles, compose files and manifests under `dir`, bounded in count and depth. */
export async function readImageSourceFiles(
  dir: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.isFile() && imageSourceKind(next) !== null) {
        const full = path.join(dir, next);
        if ((await stat(full)).size > 512 * 1024) continue;
        out.push({ path: next.split(path.sep).join('/'), content: await readFile(full, 'utf8') });
      }
    }
  };
  await walk('', 0);
  return out;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'repopulse-image-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- W23-04: the input-hash gate ---------------------------------------------
//
// The image scanner's answer depends on the files that NAME images (Dockerfiles,
// compose files, .dockerignore), on what those images contain today (the
// digest), and on the advisory database. Unchanged on all three -> nothing to
// pull. A changed database does not rematch here (no SBOM is stored per image):
// it is a full run.
//
// HONEST LIMIT: a tag like `node:20` names whatever the registry serves today.
// With no digest source the gate cannot tell that the tag moved, so it will not
// skip a run whose files name an unpinned tag — only a run whose images are all
// pinned (`@sha256:`) or whose digests the caller resolved can be up_to_date.

export type ImageScanDecision = 'up_to_date' | 'full';

export interface ImageGateArgs {
  provider: ForgeProvider;
  repo: string;
  sha: string;
  baseRun: BaseRun | null;
  dataVersion?: string | null;
  imageDigests?: () => Promise<string[] | null>;
  toolVersions?: Record<string, string> | null;
}

/** The digest salt: `''` when every named image is pinned, null when unknown. */
async function digestSalt(
  files: readonly { path: string; content: string }[],
  imageDigests: (() => Promise<string[] | null>) | undefined,
): Promise<string | null> {
  const refs = extractImageRefs(files).images;
  const unpinned = refs.filter((r) => !r.digest);
  if (unpinned.length === 0) return '';
  if (!imageDigests) return null;
  const digests = await imageDigests();
  return digests === null ? null : [...digests].sort().join(',');
}

export async function imageScanDecision(args: ImageGateArgs): Promise<ImageScanDecision> {
  const base = args.baseRun;
  if (!base || base.inputHash === null || base.inputPaths.length === 0) return 'full';
  const dataVersion =
    args.dataVersion !== undefined ? args.dataVersion : await advisoryDataVersion();
  if (dataVersion === null || base.dataVersion !== dataVersion) return 'full';
  if (!toolsMatch(base, args.toolVersions)) return 'full';
  try {
    const set = await readManifestSet(
      args.provider,
      args.repo,
      args.sha,
      mergePaths(IMAGE_ROOT_PATHS, base.inputPaths),
    );
    if (set.hash === null) return 'full';
    const salt = await digestSalt(set.files, args.imageDigests);
    if (salt === null) return 'full';
    return imageInputHash(set.hash, salt) === base.inputHash ? 'up_to_date' : 'full';
  } catch {
    return 'full';
  }
}

/** The stamped value: the file-set hash, salted with the base-image digests. */
export function imageInputHash(fileHash: string, digestSaltValue: string): string {
  return digestSaltValue === '' ? fileHash : hashFileSet([
    { path: 'files', content: fileHash },
    { path: 'digests', content: digestSaltValue },
  ]);
}

export async function runImageScan(deps: ImageRunDeps): Promise<ImageRunResult> {
  const gated = deps.baseRun !== undefined && deps.trigger !== 'pr_synced' && !deps.snapshot;
  const dataVersion = await advisoryDataVersion();
  if (gated) {
    const decision = await imageScanDecision({
      provider: deps.provider,
      repo: deps.repo,
      sha: deps.commitSha,
      baseRun: deps.baseRun ?? null,
      dataVersion,
      ...(deps.imageDigests ? { imageDigests: deps.imageDigests } : {}),
    });
    if (decision === 'up_to_date') {
      const base = deps.baseRun!;
      const scanRunId = await recordGatedRun(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scannerKey: IMAGE_SCANNER_KEY,
        commitSha: deps.commitSha,
        trigger: deps.trigger ?? 'manual',
        base,
        scope: 'skipped',
        dataVersion,
        findingCount: base.findingCount,
        note: UP_TO_DATE_NOTE,
      });
      return { status: 'succeeded', scanRunId, ...empty, findingsTotal: base.findingCount, gate: 'up_to_date' };
    }
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: IMAGE_SCANNER_KEY,
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
      dataVersion,
    })
    .returning();
  const runId = run!.id;

  const image = deps.image ?? DEFAULT_IMAGE;
  const pull = deps.pull ?? ((ref: string, dir: string) => pullImage(ref, dir));
  const scan =
    deps.scan ??
    ((dir: string) =>
      scanImageArchive({
        archiveDir: dir,
        image,
        vulnDb: deps.vulnDb ?? vulnDbDir(),
        budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
      }));
  const tags = deps.tags ?? ((i: ImageRef) => listTags(i.registry, i.repository));
  const maxImages = deps.maxImages ?? 10;
  const maxCandidates = deps.maxCandidates ?? 2;

  const pullAndScan = (
    ref: string,
  ): Promise<
    { ok: true; matches: DependencyMatch[]; grype: string | null } | { ok: false; reason: string }
  > =>
    withScratch(async (dir) => {
      const pulled = await pull(ref, dir);
      // W20-21 (UX_TODO FND-62): the two failures say different things. A pull
      // failure is the registry's answer (private, missing tag); a scan failure
      // is the sandbox's, and only that one can mean the scan tools are missing.
      if (!pulled.ok)
        return { ok: false as const, reason: `Could not pull ${ref}: ${pulled.reason}` };
      const scanned = await scan(dir);
      if (scanned.status !== 'succeeded')
        return { ok: false as const, reason: `Scan of ${ref} failed: ${scanned.error}` };
      return { ok: true as const, matches: scanned.matches, grype: scanned.grypeVersion };
    });

  const prRun = deps.trigger === 'pr_synced';
  const withTree = <T>(fn: (snapshot: { dir: string; commitSha: string }) => Promise<T>) =>
    deps.snapshot
      ? fn(deps.snapshot)
      : snapshotForScan(
          { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
          fn,
        );

  try {
    return await withTree(async (snapshot) => {
      const files = await (deps.files ?? readImageSourceFiles)(snapshot.dir);
      const refs = extractImageRefs(files);
      const byRef = distinctImages(refs.images);
      const distinct = [...byRef.entries()];
      const batch = distinct.slice(0, maxImages);

      const failed: { ref: string; reason: string }[] = [];
      const priced: PricedImageFinding[] = [];
      let grypeVersion: string | null = null;
      let scanned = 0;
      const okRefs = new Set<string>();

      for (const [ref, places] of batch) {
        const result = await pullAndScan(ref);
        if (!result.ok) {
          failed.push({ ref, reason: result.reason });
          continue;
        }
        scanned += 1;
        okRefs.add(ref);
        grypeVersion = result.grype ?? grypeVersion;
        const first = places[0]!;

        let suggestion: string | null = null;
        if (result.matches.length > 0 && first.tag && !first.digest) {
          const available = await tags(first);
          const candidates: CandidateScan[] = [];
          for (const tag of upgradeCandidates(first.tag, available ?? [], maxCandidates)) {
            const candidate = await pullAndScan(`${first.registry}/${first.repository}:${tag}`);
            candidates.push({ tag, findings: candidate.ok ? candidate.matches.length : null });
          }
          suggestion = upgradeSuggestion(
            first.repository,
            first.tag,
            result.matches.length,
            candidates,
          );
        }

        // One finding per (package, vulnerability) at the first place the image
        // is named; the other places are listed in the rationale by the file
        // being swept, not duplicated per Dockerfile.
        for (const match of result.matches) priced.push(imageFinding(first, match, suggestion));
      }

      // Swept files: those whose every image was scanned. A file naming an image
      // that failed to pull is NOT declared reviewed, so a registry outage can
      // never close a real finding.
      const sweepable = new Set<string>();
      const unswept = new Set<string>();
      for (const [ref, places] of distinct) {
        for (const p of places) (okRefs.has(ref) ? sweepable : unswept).add(p.file);
      }
      const reviewedFiles = [...sweepable].filter((f) => !unswept.has(f));

      const persisted = await persistFindings(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scanRunId: runId,
        pullRequestId: deps.pullRequestId ?? null,
        tier: 1,
        findings: priced.map((p) => p.finding),
        ...(prRun ? {} : { reviewedFiles }),
        sweepDimensions: ['dependency'],
        sweepScannerKey: IMAGE_SCANNER_KEY,
      });

      for (const entry of priced) {
        await deps.db
          .update(read.findings)
          .set({
            effectiveRisk: String(entry.pricing.effectiveRisk),
            riskBand: entry.pricing.band,
            riskFactors: entry.pricing.riskFactors as unknown as Record<string, unknown>,
          })
          .where(
            and(
              eq(read.findings.workspaceId, deps.workspaceId),
              eq(read.findings.repoId, deps.repoId),
              eq(read.findings.dedupKey, entry.key),
            ),
          );
      }

      // Every image failing is a failed run. Some failing, or images left
      // over the cap, is a PARTIAL run (W20-21, UX_TODO FND-62): it was stored
      // as succeeded-with-an-error, which the Coverage table reads as "ran,
      // but nothing was scanned" right beside the CVEs it had written.
      const overCap = distinct.slice(maxImages).map(([ref]) => ref);
      const status = batch.length > 0 && scanned === 0 ? 'failed' : 'succeeded';
      const partial = status === 'succeeded' && (failed.length > 0 || overCap.length > 0);
      const notes = failed.map((f) => f.reason);
      if (overCap.length > 0) {
        notes.push(
          `Not scanned (over the ${maxImages}-image limit per run): ${overCap.slice(0, 10).join(', ')}${overCap.length > 10 ? ` and ${overCap.length - 10} more` : ''}`,
        );
      }
      const error = notes.length > 0 ? notes.join('; ').slice(0, 1000) : null;
      // W23-04: stamp the inputs this run read. Only a clean, whole run is a
      // baseline (a partial one is never offered by latestBaseRun), and the
      // digests are folded in only when every unpinned image has a known one.
      let stamp: Record<string, string> | null = null;
      if (!prRun && grypeVersion) {
        // Not every yaml in the tree: only the files that name an image, plus
        // every Dockerfile and compose-named file (the ones that could start
        // to). A Kubernetes manifest that names no image today and gains one
        // is the residual gap, stated in the RUNBOOK.
        const naming = new Set(refs.images.map((i) => i.file));
        const paths = mergePaths(
          IMAGE_ROOT_PATHS,
          files
            .filter(
              (f) =>
                imageSourceKind(f.path) === 'dockerfile' ||
                /compose/i.test(f.path.split('/').pop() ?? '') ||
                naming.has(f.path),
            )
            .map((f) => f.path),
        );
        const onDisk = hashSnapshotFiles(snapshot.dir, paths);
        const salt = await digestSalt(files, deps.imageDigests).catch(() => null);
        if (onDisk.hash !== null && salt !== null) {
          stamp = stampInputs(
            { grype: grypeVersion },
            imageInputHash(onDisk.hash, salt),
            onDisk.paths,
          );
        }
      }
      await closeRun(deps.db, runId, status, priced.length, error, grypeVersion, partial, stamp);

      return {
        status,
        scanRunId: runId,
        imagesNamed: distinct.length,
        imagesScanned: scanned,
        imagesFailed: failed,
        imagesSkipped: refs.skipped.length,
        imagesOverCap: Math.max(0, distinct.length - batch.length),
        findingsCreated: persisted.created,
        findingsTotal: priced.length,
        ...(error ? { error } : {}),
      };
    });
  } catch (err) {
    await closeRun(deps.db, runId, 'failed', 0, safeErrorText(err).slice(0, 500), null);
    return { status: 'failed', scanRunId: runId, ...empty, error: safeErrorText(err) };
  }
}

async function closeRun(
  db: Database,
  runId: number,
  status: 'succeeded' | 'failed',
  findingCount: number,
  error: string | null,
  grypeVersion: string | null,
  partial = false,
  stamp: Record<string, string> | null = null,
): Promise<void> {
  await db
    .update(security.scanRuns)
    .set({
      status,
      partial,
      findingCount,
      error,
      finishedAt: new Date(),
      ...(grypeVersion
        ? {
            toolVersions: stamp ?? { grype: grypeVersion },
            scannerVersion: stamp ? toolLabel(stamp) : `grype@${grypeVersion}`,
          }
        : {}),
    })
    .where(eq(security.scanRuns.id, runId));
}
