import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { repriceFindings } from '@repopulse/insights';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { runDependencyScan } from './run.js';
import { DEPENDENCY_SCANNER_KEY } from './findings.js';
import { checkVulnDb, vulnDbDir } from './tools.js';

// The dependency scanner end to end (W8-06, FR-SEC-5).
//
// A snapshot is taken, syft and grype run in the sandbox, the SBOM lands in
// security.sboms — the table W8-02 built and nothing has ever written to — and
// the CVEs land in findings priced by the D12 model.

const databaseUrl = process.env.DATABASE_URL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/dependency');

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const vulnDb = vulnDbDir();
const describeIfReady =
  databaseUrl && scanImage && checkVulnDb(vulnDb).ok ? describe : describe.skip;

const FP = 'w8-06-fp';
const SHA = 'w8-06-commit-sha-00000000000000000000';

/** A real archive of the vulnerable fixture, built by the system tar. */
function tarball(): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w8-06-stage-'));
  const top = path.join(stage, 'acme-deps-abc1234');
  mkdirSync(top, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    writeFileSync(path.join(top, file), readFileSync(path.join(FIXTURES, 'vulnerable', file)));
  }
  const out = path.join(stage, 'archive.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

function fakeProvider(calls: CallCtx[]): ForgeProvider {
  const bytes = tarball();
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getTarball: async (ctx: CallCtx, _repo: string, sha: string) => {
      calls.push(ctx);
      return { commitSha: sha, bytes, sourceHost: 'codeload.github.com' };
    },
  } as unknown as ForgeProvider;
}

describeIfReady('dependency scan (W8-06)', () => {
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
      .values({
        authProvider: 'github',
        authSubject: 'w8-06-user',
        forgeUserId: 'w8-06-user',
        login: 'w8-06-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-06-user' } })
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
        forgeRepoId: 'w8-06-repo',
        org: 'acme',
        name: 'deps',
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
    await db.delete(security.sboms).where(eq(security.sboms.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('stores the SBOM and the CVEs, and reports its funnel', async () => {
    const calls: CallCtx[] = [];
    const result = await runDependencyScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/deps',
      commitSha: SHA,
      image: scanImage as string,
      vulnDb,
      trigger: 'manual',
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    // The archive came down the scan lane, like every other scanner fetch.
    expect(calls.map((c) => c.lane)).toEqual(['scan']);

    // security.sboms has been empty since W8-02 built it, which is why
    // owasp_llm reports 'no_sbom' for every repository. This row is the fix.
    const [sbom] = await db
      .select()
      .from(security.sboms)
      .where(and(eq(security.sboms.repoId, repoId), eq(security.sboms.commitSha, SHA)));
    expect(sbom).toBeDefined();
    expect(sbom!.componentCount).toBeGreaterThan(0);
    expect(sbom!.generatedBy).toMatch(/^syft@\d+\.\d+\.\d+$/);
    expect((sbom!.document as { bomFormat?: string }).bomFormat).toBe('CycloneDX');

    // The funnel, reported rather than summarised: a finding count alone
    // cannot tell "nothing is wrong" from "the scan lost things on the way".
    expect(result.componentsScanned).toBe(sbom!.componentCount);
    expect(result.matchesFound).toBeGreaterThan(0);
    expect(result.withoutCveId).toBe(0);

    const findings = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'dependency')));
    const kev = findings.find((f) => f.cveId === 'CVE-2020-11023');
    expect(kev, findings.map((f) => f.cveId).join(', ')).toBeDefined();
    expect(kev!.severity).toBeGreaterThanOrEqual(4);
    expect(kev!.scannerKey).toBe(DEPENDENCY_SCANNER_KEY);
    expect((kev!.yields as Record<string, unknown>)['kev']).toBe(true);
    // The UI facet and the API filter both query `yields ->> 'kev' = 'true'`.
    expect((kev!.yields as Record<string, unknown>)[`vuln-dependency:${kev!.cveId}`]).toBe(true);

    // W8-13: the funnel is reported, and it dismissed nothing.
    expect(result.validation?.raw).toBeGreaterThan(0);
    expect(result.validation?.deduped).toBe(findings.length);
    expect(result.validation?.dismissed).toBe(0);
    // The snapshot here holds only the two manifest files (see tarball()), so
    // V2 has no sources to read and says so by leaving jquery unproven rather
    // than by claiming it is unused — the fail-safe direction.
    expect((kev!.yields as Record<string, unknown>)['usage']).toBe('not_imported');
    expect((kev!.yields as Record<string, unknown>)['reachability']).toBe('manifest_only');

    // V3 was not run and says why, instead of leaving silence to be read as
    // proof that nothing is reachable.
    expect(result.reachabilityNote).toMatch(/Go vulnerability database|go\.mod/);

    // V4: the scan PRICED what it stored. Before W8-13 a dependency finding
    // had a null effective_risk until the nightly reprice ran.
    expect(result.findingsPriced).toBe(findings.length);
    expect(kev!.effectiveRisk).not.toBeNull();
    expect(kev!.riskBand).toBe('act');
    expect((kev!.riskFactors as { inputs?: Record<string, unknown> }).inputs?.['epss']).toBeTypeOf(
      'number',
    );
  }, 300_000);

  it('re-running the same commit creates NO new rows', async () => {
    // The store's contract. A dependency list that grows every night is one
    // people stop reading — and it would move the health score without anyone
    // changing the code.
    const before = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'dependency')));

    const result = await runDependencyScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/deps',
      commitSha: SHA,
      image: scanImage as string,
      vulnDb,
      trigger: 'manual',
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findingsCreated).toBe(0);
    const after = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'dependency')));
    expect(after).toHaveLength(before.length);
  }, 300_000);

  it('prices a KEV finding into the act band', async () => {
    // The D12 half: `kev: true` in yields is what repriceFindings reads, and it
    // stops predicting — likelihood 1 and the band forced.
    //
    // W8-13 NOTE, because this test is where it will be noticed: reprice builds
    // its PricingInput from `kev` and `dep_scope` only, so it DROPS the `epss`
    // and `reachability` the scan wrote. A KEV finding is unaffected (kev
    // forces L=1 either way); a non-KEV one is re-priced down to the likelihood
    // floor overnight. The two-line fix is in packages/insights, outside this
    // ticket's write scope, and validation.test.ts pins the divergence.
    await repriceFindings({ db, workspaceId, repoId });
    const [kev] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.cveId, 'CVE-2020-11023')));
    expect(kev!.riskBand).toBe('act');
    expect(Number((kev!.riskFactors as { L?: number }).L)).toBe(1);
  }, 60_000);

  it('a failed tool run leaves a FAILED scan_run and resolves nothing', async () => {
    // THE CATASTROPHIC FORM of "found nothing": a crashed scanner reaching the
    // store with an empty findings list would auto-resolve every dependency
    // finding this repository has — real CVEs marked fixed because grype did
    // not start.
    const result = await runDependencyScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/deps',
      commitSha: SHA,
      image: scanImage as string,
      vulnDb: path.join(tmpdir(), 'w8-06-no-database-here'),
      trigger: 'manual',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no vulnerability database/);
    expect(result.sbomStored).toBe(false);

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, result.scanRunId as number));
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/no vulnerability database/);

    const findings = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'dependency')));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.status === 'open')).toBe(true);
  }, 120_000);
});
