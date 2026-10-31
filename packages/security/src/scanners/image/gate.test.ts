import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import {
  IMAGE_ROOT_PATHS,
  INPUT_HASH_KEY,
  INPUT_PATHS_KEY,
  mergePaths,
  readManifestSet,
  type BaseRun,
} from '../../framework/input-hash.js';
import { imageInputHash, imageScanDecision, runImageScan } from './run.js';
import { IMAGE_SCANNER_KEY } from './findings.js';

// W23-04. container_image: the hash of the files that name images (+ digests
// where known) and the advisory stamp decide whether to pull anything.

const STAMP = '6@2026-10-31T01:00:00Z';
const PINNED = 'FROM node@sha256:' + 'a'.repeat(64) + '\n';
const UNPINNED = 'FROM node:20\n';

function provider(files: Record<string, string>, tarball: string[] = []): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getFileContent: async (_c: unknown, _r: string, p: string, ref: string) => {
      const hit = files[p];
      if (hit === undefined) throw Object.assign(new Error('nf'), { status: 404 });
      return { path: p, ref, sizeBytes: hit.length, content: hit, truncated: false };
    },
    getTarball: async (_c: unknown, _r: string, sha: string) => {
      tarball.push(sha);
      throw new Error('tarball fetched');
    },
  } as unknown as ForgeProvider;
}

async function baseFor(files: Record<string, string>, salt = '', over: Partial<BaseRun> = {}): Promise<BaseRun> {
  const set = await readManifestSet(provider(files), 'o/r', 'b', mergePaths(IMAGE_ROOT_PATHS, Object.keys(files)));
  const hash = imageInputHash(set.hash!, salt);
  return {
    id: 7,
    commitSha: 'b',
    scope: 'full',
    findingCount: 2,
    toolVersions: { grype: '0.117', [INPUT_HASH_KEY]: hash, [INPUT_PATHS_KEY]: JSON.stringify(set.paths) },
    dataVersion: STAMP,
    inputHash: hash,
    inputPaths: set.paths,
    ...over,
  };
}

describe('imageScanDecision', () => {
  const args = (files: Record<string, string>, base: BaseRun | null, extra = {}) => ({
    provider: provider(files),
    repo: 'o/r',
    sha: 'new',
    baseRun: base,
    dataVersion: STAMP,
    ...extra,
  });

  it('same Dockerfile, same data, image pinned by digest -> up_to_date', async () => {
    const files = { Dockerfile: PINNED };
    expect(await imageScanDecision(args(files, await baseFor(files)))).toBe('up_to_date');
  });

  it('a Dockerfile edit -> full', async () => {
    const base = await baseFor({ Dockerfile: PINNED });
    expect(await imageScanDecision(args({ Dockerfile: PINNED + 'RUN true\n' }, base))).toBe('full');
  });

  it('a compose file or .dockerignore edit -> full', async () => {
    const files = { Dockerfile: PINNED, 'compose.yaml': 'services: {}\n', '.dockerignore': 'a\n' };
    const base = await baseFor(files);
    expect(await imageScanDecision(args({ ...files, '.dockerignore': 'a\nb\n' }, base))).toBe('full');
    expect(await imageScanDecision(args({ ...files, 'compose.yaml': 'services: {a: 1}\n' }, base))).toBe('full');
  });

  it('a changed advisory stamp -> full (no SBOM is stored per image, so no rematch)', async () => {
    const files = { Dockerfile: PINNED };
    const base = await baseFor(files, '', { dataVersion: '6@2026-10-01T00:00:00Z' });
    expect(await imageScanDecision(args(files, base))).toBe('full');
  });

  it('an unpinned tag is never skipped without a digest source — the tag may have moved', async () => {
    const files = { Dockerfile: UNPINNED };
    const base = await baseFor(files, 'sha256:one');
    expect(await imageScanDecision(args(files, base))).toBe('full');
  });

  it('an unpinned tag with a digest source: same digest -> up_to_date, moved digest -> full', async () => {
    const files = { Dockerfile: UNPINNED };
    const base = await baseFor(files, 'sha256:one');
    expect(await imageScanDecision(args(files, base, { imageDigests: async () => ['sha256:one'] }))).toBe('up_to_date');
    expect(await imageScanDecision(args(files, base, { imageDigests: async () => ['sha256:two'] }))).toBe('full');
    expect(await imageScanDecision(args(files, base, { imageDigests: async () => null }))).toBe('full');
  });

  it('no baseline, a pre-gate baseline, or a forge error -> full', async () => {
    const files = { Dockerfile: PINNED };
    expect(await imageScanDecision(args(files, null))).toBe('full');
    expect(await imageScanDecision(args(files, { ...(await baseFor(files)), inputHash: null }))).toBe('full');
    const broken = { ...provider(files), getFileContent: async () => { throw Object.assign(new Error('x'), { status: 500 }); } } as unknown as ForgeProvider;
    expect(await imageScanDecision({ ...args(files, await baseFor(files)), provider: broken })).toBe('full');
  });
});

describe('runImageScan with a baseline', () => {
  let rulesDir: string;
  beforeEach(() => {
    rulesDir = mkdtempSync(path.join(tmpdir(), 'w2304-img-'));
    process.env['SCAN_RULES_DIR'] = rulesDir;
    writeFileSync(path.join(rulesDir, 'vuln-db.version'), `${STAMP}\n`);
  });
  afterEach(() => {
    delete process.env['SCAN_RULES_DIR'];
  });

  const fakeDb = () => {
    const inserted: Record<string, unknown>[] = [];
    return {
      inserted,
      db: {
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            inserted.push(v);
            return { returning: async () => [{ id: 500 + inserted.length }] };
          },
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      } as never,
    };
  };

  it('unchanged -> one skipped row at the real commit; no tarball, no pull', async () => {
    const files = { Dockerfile: PINNED };
    const tar: string[] = [];
    const { db, inserted } = fakeDb();
    let pulled = 0;
    const result = await runImageScan({
      db,
      provider: provider(files, tar),
      workspaceId: 1,
      repoId: 2,
      repo: 'o/r',
      commitSha: 'new',
      baseRun: await baseFor(files),
      pull: async () => {
        pulled += 1;
        return { ok: false, reason: 'no' } as never;
      },
    });
    expect(result).toMatchObject({ status: 'succeeded', gate: 'up_to_date', findingsTotal: 2, imagesScanned: 0 });
    expect(tar).toEqual([]);
    expect(pulled).toBe(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      scannerKey: IMAGE_SCANNER_KEY,
      commitSha: 'new',
      scope: 'skipped',
      baseRunId: 7,
      findingCount: 2,
      dataVersion: STAMP,
    });
  });

  it('changed Dockerfile -> the full path (the tarball is asked for)', async () => {
    const tar: string[] = [];
    const { db, inserted } = fakeDb();
    const base = await baseFor({ Dockerfile: PINNED });
    const result = await runImageScan({
      db,
      provider: provider({ Dockerfile: PINNED + '# changed\n' }, tar),
      workspaceId: 1,
      repoId: 2,
      repo: 'o/r',
      commitSha: 'new',
      baseRun: base,
    });
    expect(tar).toEqual(['new']);
    expect(result.status).toBe('failed');
    expect(inserted.map((i) => i['scope'])).not.toContain('skipped');
  });
});
