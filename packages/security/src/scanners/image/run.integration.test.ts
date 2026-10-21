import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import type { DependencyMatch } from '../dependency/matches.js';
import { runImageScan, type ImageRunDeps } from './run.js';

// The image scanner's orchestration (W18-34), with the registry and grype
// faked: what is tested is which images are named, what is swept, how a
// partial pull is reported and when an upgrade is suggested.

const databaseUrl = process.env.DATABASE_URL;
const FP = 'w18-34-fp';
const describeIfDb = databaseUrl ? describe : describe.skip;

const match = (id: string, pkg: string): DependencyMatch =>
  ({
    vulnerabilityId: id,
    ids: [id],
    cveId: id,
    severityLabel: 'High',
    severity: 4,
    kev: false,
    epss: null,
    purl: null,
    packageName: pkg,
    packageVersion: '1.0',
    packageType: 'deb',
    locations: [],
    fixVersions: ['1.1'],
    matchType: 'exact-direct-match',
  }) as unknown as DependencyMatch;

/** A real (tiny) archive: the snapshot step extracts it before the faked file reader runs. */
function tarball(): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w18-34-stage-'));
  const top = path.join(stage, 'acme-imgs-abc1234');
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'README.md'), 'x');
  const out = path.join(stage, 'archive.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

const bytes = tarball();
const provider = {
  kind: 'github',
  capabilities: { supportsTarball: true },
  getTarball: async () => ({ commitSha: 'x', bytes, sourceHost: 'codeload.github.com' }),
} as unknown as ForgeProvider;

describeIfDb('container image scan (W18-34)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w18-34-user', forgeUserId: 'w18-34-user', login: 'w18-34-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-34-user' } })
      .returning();
    userId = user!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: FP,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w18-34-repo',
        org: 'acme',
        name: 'imgs',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  const files = async () => [
    { path: 'Dockerfile', content: 'FROM node:20-alpine\n' },
    { path: 'deploy/compose.yml', content: 'services:\n  db:\n    image: postgres:16\n' },
  ];

  const base = (over: Partial<ImageRunDeps>): ImageRunDeps => ({
    db,
    provider,
    workspaceId,
    repoId,
    repo: 'acme/imgs',
    commitSha: 'w18-34-sha',
    trigger: 'manual',
    files,
    pull: async (_ref, dir) => ({ ok: true, archive: `${dir}/image.tar` }),
    ...over,
  });

  it('files findings against the Dockerfile and suggests the upgrade that clears them', async () => {
    let current = '';
    const result = await runImageScan(
      base({
        pull: async (ref, dir) => {
          current = ref;
          return { ok: true, archive: `${dir}/image.tar` };
        },
        scan: async () => ({
          status: 'succeeded',
          grypeVersion: '0.117.0',
          matches: current === 'node:20-alpine' ? [match('CVE-2024-0001', 'busybox'), match('CVE-2024-0002', 'musl')] : [],
        }),
        tags: async () => ['20-alpine', '22-alpine'],
      }),
    );
    expect(result).toMatchObject({ status: 'succeeded', imagesNamed: 2, imagesScanned: 2, findingsTotal: 2 });

    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'container_image')));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.file === 'Dockerfile' && r.status === 'open')).toBe(true);
    expect(rows[0]!.recommendation).toMatch(/22-alpine clears all 2 findings/);
    expect(rows[0]!.effectiveRisk).not.toBeNull();
  });

  it('a registry outage fails the run for that image and never closes its findings', async () => {
    const result = await runImageScan(
      base({
        pull: async (ref, dir) =>
          ref.startsWith('node')
            ? { ok: false, reason: 'skopeo could not pull node:20-alpine: timeout' }
            : { ok: true, archive: `${dir}/image.tar` },
        scan: async () => ({ status: 'succeeded', grypeVersion: '0.117.0', matches: [] }),
      }),
    );
    expect(result.status).toBe('succeeded');
    expect(result.imagesFailed).toEqual([{ ref: 'node:20-alpine', reason: expect.stringMatching(/timeout/) }]);
    expect(result.error).toMatch(/node:20-alpine/);
    // W20-21 (FND-62): partial, and the pull failure is named as one.
    expect(result.error).toMatch(/^Could not pull node:20-alpine/);
    const [runRow] = await db
      .select({ partial: security.scanRuns.partial })
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, result.scanRunId!));
    expect(runRow?.partial).toBe(true);

    // Dockerfile names the image that failed, so it was not declared reviewed.
    const open = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'container_image'), eq(read.findings.status, 'open')));
    expect(open).toHaveLength(2);
  });

  it('closes findings once the image is clean and scanned', async () => {
    const result = await runImageScan(
      base({ scan: async () => ({ status: 'succeeded', grypeVersion: '0.117.0', matches: [] }) }),
    );
    expect(result).toMatchObject({ status: 'succeeded', findingsTotal: 0 });
    const open = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'container_image'), eq(read.findings.status, 'open')));
    expect(open).toHaveLength(0);
  });

  it('is a failed run when every image failed', async () => {
    const result = await runImageScan(
      base({ pull: async () => ({ ok: false, reason: 'unauthorized' }) }),
    );
    expect(result.status).toBe('failed');
    expect(result.imagesScanned).toBe(0);
  });

  it('reports images past the cap instead of dropping them silently', async () => {
    const result = await runImageScan(
      base({
        maxImages: 1,
        scan: async () => ({ status: 'succeeded', grypeVersion: null, matches: [] }),
      }),
    );
    expect(result).toMatchObject({ imagesNamed: 2, imagesScanned: 1, imagesOverCap: 1 });
  });
});
