import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import { runTestGapRegister } from './run.js';
import { fileChangeStats } from './register.js';
import { repriceFindings } from '../../risk/reprice.js';

// The test-gap register end to end (W10-04, FR-REG-6, D12).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w10-04-fp';

describeIfLiveInfra('test-gap register', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let identityId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w10-04-user', login: 'w10-04-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w10-04-user' } })
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
        forgeRepoId: 'w10-04-repo',
        org: 'acme',
        name: 'test-gap',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [identity] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'w10-04-dev', displayName: 'dev' })
      .onConflictDoUpdate({
        target: [core.identities.workspaceId, core.identities.provider, core.identities.forgeLogin],
        set: { displayName: 'dev' },
      })
      .returning();
    identityId = identity!.id;

    let seq = 0;
    const commit = async (files: { path: string; lines: number }[]) => {
      seq += 1;
      const at = new Date(Date.now() - 10 * 86_400_000);
      const [row] = await db
        .insert(facts.commits)
        .values({
          workspaceId,
          repoId,
          sha: `w10-04-sha-${seq}`,
          authorIdentityId: identityId,
          committerIdentityId: identityId,
          messageHead: `commit ${seq}`,
          authoredAt: at,
          committedAt: at,
          isRevertHeuristic: false,
          isMerge: false,
        })
        .returning();
      for (const file of files) {
        await db.insert(facts.commitFiles).values({
          workspaceId,
          repoId,
          commitId: row!.id,
          path: file.path,
          additions: file.lines,
          deletions: 0,
          status: 'modified',
        });
      }
    };

    // src/payments.ts: hot, and never once accompanied by a test.
    for (let i = 0; i < 10; i += 1) await commit([{ path: 'src/payments.ts', lines: 120 }]);
    // src/cart.ts: equally hot, but its changes ship with a test every time.
    for (let i = 0; i < 10; i += 1) {
      await commit([
        { path: 'src/cart.ts', lines: 110 },
        { path: 'src/cart.test.ts', lines: 40 },
      ]);
    }
    // src/readme-ish cold file, below every floor.
    await commit([{ path: 'src/cold.ts', lines: 3 }]);
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.repoId, repoId));
    await db.delete(facts.commits).where(eq(facts.commits.repoId, repoId));
    await db.delete(core.identities).where(inArray(core.identities.id, [identityId]));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w10-04-user'));
  });

  it('counts co-change per file out of the warehouse', async () => {
    const state = await fileChangeStats(db, repoId, new Date(Date.now() - 90 * 86_400_000));
    const payments = state.files.find((f) => f.path === 'src/payments.ts')!;
    const cart = state.files.find((f) => f.path === 'src/cart.ts')!;

    expect(payments.commits).toBe(10);
    expect(payments.commitsWithTests).toBe(0);
    expect(cart.commitsWithTests).toBe(10);
    // The test file itself is never a subject of the register.
    expect(state.files.map((f) => f.path)).not.toContain('src/cart.test.ts');
    expect(state.hasNoTests).toBe(false);
  });

  it('stores exactly the untested hot file, and prices it', async () => {
    const result = await runTestGapRegister({ db, workspaceId, repoId });
    expect(result.status).toBe('succeeded');

    const rows = await db
      .select({ file: read.findings.file, ruleId: read.findings.ruleId })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'test_gap')));

    expect(rows.map((r) => r.file)).toEqual(['src/payments.ts']);
    expect(rows[0]!.ruleId).toBe('test_gap.hot_file');

    await repriceFindings({ db, workspaceId, repoId });
    const [priced] = await db
      .select({ effectiveRisk: read.findings.effectiveRisk, riskFactors: read.findings.riskFactors })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'test_gap')));

    const factors = priced!.riskFactors as unknown as { H: number; L: number; X: number };
    expect(Math.round(100 * factors.H * factors.L * factors.X * 100) / 100).toBeCloseTo(
      Number(priced!.effectiveRisk),
      2,
    );
  });

  it('a second pass creates nothing new', async () => {
    const result = await runTestGapRegister({ db, workspaceId, repoId });
    expect(result.created).toBe(0);
  });
});
