import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/index.js';
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

export async function runImageScan(deps: ImageRunDeps): Promise<ImageRunResult> {
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
      await closeRun(deps.db, runId, status, priced.length, error, grypeVersion, partial);

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
        ? { toolVersions: { grype: grypeVersion }, scannerVersion: `grype@${grypeVersion}` }
        : {}),
    })
    .where(eq(security.scanRuns.id, runId));
}
