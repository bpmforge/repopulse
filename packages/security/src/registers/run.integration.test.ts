import 'dotenv/config';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { priceFinding, repriceFindings } from '@repopulse/insights';
import { runSupplyChainRegisters, policyFrom, SUPPLY_CHAIN_REGISTER_KEY } from './run.js';
import { syncReleaseMeta } from '../sync/release-meta.js';
import { syncEolProducts } from '../sync/eol.js';

// The supply-chain registers end to end (W10-02, FR-REG-2/3/4, D12).
//
// The SBOM is a PINNED FIXTURE inserted directly, which is also the honest
// production picture: nothing generates SBOMs yet because W8-06 is blocked for
// missing syft. What this proves is that given a component list, the registers
// price, scope and store correctly — not that the pipeline in front of them
// exists.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w10-02-fp';

const SBOM = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: { component: { 'bom-ref': 'root', name: 'acme-app' } },
  components: [
    {
      'bom-ref': 'prod-abandoned',
      name: 'w10-02-abandoned',
      version: '1.0.0',
      purl: 'pkg:npm/w10-02-abandoned@1.0.0',
      licenses: [{ license: { id: 'MIT' } }],
    },
    {
      'bom-ref': 'dev-abandoned',
      name: 'w10-02-dev',
      version: '1.0.0',
      purl: 'pkg:npm/w10-02-dev@1.0.0',
      scope: 'excluded',
      licenses: [{ license: { id: 'MIT' } }],
    },
    {
      'bom-ref': 'copyleft',
      name: 'w10-02-copyleft',
      version: '2.0.0',
      purl: 'pkg:npm/w10-02-copyleft@2.0.0',
      licenses: [{ license: { id: 'AGPL-3.0' } }],
    },
  ],
  dependencies: [{ ref: 'root', dependsOn: ['prod-abandoned', 'copyleft'] }],
};

describeIfLiveInfra('supply-chain registers', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let snapshotDir = '';

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w10-02-user', login: 'w10-02-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w10-02-user' } })
      .returning();

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
        createdBy: user!.id,
      })
      .returning();

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w10-02-repo',
        org: 'acme',
        name: 'supply-chain',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    await db
      .insert(security.sboms)
      .values({
        workspaceId,
        repoId,
        commitSha: 'w10-02-sha',
        format: 'cyclonedx',
        document: SBOM,
        componentCount: SBOM.components.length,
        generatedBy: 'fixture',
      })
      .onConflictDoUpdate({
        target: [security.sboms.workspaceId, security.sboms.repoId, security.sboms.commitSha],
        set: { document: SBOM },
      });

    // release_meta via the SYNC path with a stub fetcher — the same code the
    // nightly job runs, so a change to the upsert breaks this test.
    await syncReleaseMeta({
      db,
      packages: [
        { ecosystem: 'npm', name: 'w10-02-abandoned', installedVersions: ['1.0.0'] },
        { ecosystem: 'npm', name: 'w10-02-dev', installedVersions: ['1.0.0'] },
        { ecosystem: 'npm', name: 'w10-02-copyleft', installedVersions: ['2.0.0'] },
      ],
      fetchJson: async (url: string) => {
        const stale = url.includes('copyleft') ? '2026-08-01' : '2021-01-01';
        const version = url.includes('copyleft') ? '2.0.0' : '1.5.0';
        return {
          'dist-tags': { latest: version },
          time: { [version]: `${stale}T00:00:00.000Z`, '1.0.0': '2020-01-01T00:00:00.000Z' },
          versions: { [version]: {} },
        };
      },
    });

    await syncEolProducts({
      db,
      products: ['w10-02-runtime'],
      fetchJson: async () => ({
        result: {
          releases: [
            { name: '18', eolFrom: '2025-04-30', eoasFrom: null, latest: { name: '18.20.0' } },
          ],
        },
      }),
    });

    snapshotDir = mkdtempSync(path.join(tmpdir(), 'w10-02-snap-'));
    writeFileSync(path.join(snapshotDir, 'Dockerfile'), 'FROM w10-02-runtime:18-alpine\n');
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(security.sboms).where(eq(security.sboms.repoId, repoId));
    await db
      .delete(security.releaseMeta)
      .where(inArray(security.releaseMeta.package, ['w10-02-abandoned', 'w10-02-dev', 'w10-02-copyleft']));
    await db.delete(security.eolProducts).where(eq(security.eolProducts.product, 'w10-02-runtime'));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w10-02-user'));
  });

  it('stores dependency-health, license and EOL findings from one run', async () => {
    const result = await runSupplyChainRegisters({
      db,
      workspaceId,
      repoId,
      snapshotDir,
      now: new Date('2026-08-19T00:00:00Z'),
    });

    if (result.status !== 'succeeded') throw new Error(result.error ?? 'no error reported');
    expect(result.status).toBe('succeeded');
    expect(result.measured).toBe(3);
    expect(result.unmeasured).toBe(0);

    const rows = await db
      .select({ ruleId: read.findings.ruleId, title: read.findings.title })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'dependency_health')));

    const rules = rows.map((r) => r.ruleId);
    expect(rules).toContain('dependency_health.abandoned');
    expect(rules).toContain('license.policy');
    expect(rules).toContain('eol.past');
  });

  it('runs under one scan_run, which finishes succeeded', async () => {
    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(eq(security.scanRuns.repoId, repoId), eq(security.scanRuns.scannerKey, SUPPLY_CHAIN_REGISTER_KEY)),
      );
    expect(run?.status).toBe('succeeded');
    expect(run?.finishedAt).toBeTruthy();
  });

  it('prices the dev-scoped copy of the same problem BELOW the prod one (D12)', async () => {
    await repriceFindings({ db, workspaceId, repoId });

    const rows = await db
      .select({
        title: read.findings.title,
        effectiveRisk: read.findings.effectiveRisk,
        riskBand: read.findings.riskBand,
        riskFactors: read.findings.riskFactors,
      })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'dependency_health.abandoned')));

    const prod = rows.find((r) => r.title.includes('w10-02-abandoned'))!;
    const dev = rows.find((r) => r.title.includes('w10-02-dev'))!;
    expect(Number(prod.effectiveRisk)).toBeGreaterThan(Number(dev.effectiveRisk));

    // The exposure factor is the D12 dep_scope multiplier, not a re-derivation.
    const devFactors = dev.riskFactors as unknown as { X: number };
    expect(devFactors.X).toBeCloseTo(0.35 * 0.6, 5);
  });

  it('serves the decomposition that reproduces the stored score (FR-REG-7)', async () => {
    const [row] = await db
      .select({ effectiveRisk: read.findings.effectiveRisk, riskFactors: read.findings.riskFactors })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'eol.past')));

    const factors = row!.riskFactors as unknown as { H: number; L: number; X: number };
    expect(Math.round(100 * factors.H * factors.L * factors.X * 100) / 100).toBeCloseTo(
      Number(row!.effectiveRisk),
      2,
    );
  });

  it('says no_sbom rather than "clean" for a repo nothing has scanned', async () => {
    const result = await runSupplyChainRegisters({ db, workspaceId, repoId: -1 });
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('no_sbom');
    expect(result.scanRunId).toBeNull();
  });

  it('defaults the license policy when the workspace has not set one', () => {
    expect(policyFrom({}).flag).toContain('AGPL-3.0');
    expect(policyFrom({ licensePolicy: { flag: ['GPL-3.0'] } }).flag).toEqual(['GPL-3.0']);
    // priceFinding is the same function the repricer used above — imported
    // here so this file fails if the export ever moves.
    expect(priceFinding({ dimension: 'dependency_health', severity: 3, confidence: 4 }).band).toBeTruthy();
  });
});
