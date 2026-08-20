import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import { runKnowledgeRegister } from './run.js';
import { moduleConcentration } from './register.js';
import { priceFinding } from '../../risk/price.js';

// The knowledge register end to end (W10-01, FR-REG-1, N-9, D12).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w10-01-fp';

describeIfLiveInfra('knowledge register', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let soloId = 0;
  let otherId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w10-01-user', login: 'w10-01-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w10-01-user' } })
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
        forgeRepoId: 'w10-01-repo',
        org: 'acme',
        name: 'knowledge',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // Idempotent: an earlier crashed run leaves these rows behind, and a bare
    // insert then fails in beforeAll — which vitest reports as SKIPPED, not
    // failed. That is the same trap W8-02 hit: a skipped suite proves nothing
    // and looks green.
    const identity = async (login: string) => {
      const [row] = await db
        .insert(core.identities)
        .values({ workspaceId, provider: 'github', forgeLogin: login, displayName: login })
        .onConflictDoUpdate({
          target: [core.identities.workspaceId, core.identities.provider, core.identities.forgeLogin],
          set: { displayName: login },
        })
        .returning();
      return row!.id;
    };
    soloId = await identity('w10-01-solo');
    otherId = await identity('w10-01-other');

    let commitSeq = 0;
    const commit = async (authorId: number, files: { path: string; lines: number }[]) => {
      commitSeq += 1;
      const at = new Date(Date.now() - 30 * 86_400_000);
      const [row] = await db
        .insert(facts.commits)
        .values({
          workspaceId,
          repoId,
          sha: `w10-01-sha-${commitSeq}`,
          authorIdentityId: authorId,
          committerIdentityId: authorId,
          messageHead: `commit ${commitSeq}`,
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

    // src/solo: one contributor, 900 lines — concentrated.
    await commit(soloId, [{ path: 'src/solo/a.ts', lines: 500 }]);
    await commit(soloId, [{ path: 'src/solo/b.ts', lines: 400 }]);
    // src/shared: two contributors, evenly split — not concentrated.
    await commit(soloId, [{ path: 'src/shared/a.ts', lines: 400 }]);
    await commit(otherId, [{ path: 'src/shared/b.ts', lines: 400 }]);
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.repoId, repoId));
    await db.delete(facts.commits).where(eq(facts.commits.repoId, repoId));
    // BY ID, not by workspace: the default workspace is shared with every
    // other suite, and a workspace-wide identity delete would take theirs too.
    await db.delete(core.identities).where(inArray(core.identities.id, [soloId, otherId]));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('computes concentration per module from the warehouse alone', async () => {
    const modules = await moduleConcentration(
      db,
      repoId,
      new Date(Date.now() - 180 * 86_400_000),
    );
    const solo = modules.find((m) => m.module === 'src/solo');
    const shared = modules.find((m) => m.module === 'src/shared');
    expect(solo).toMatchObject({ maintainers: 1, totalLines: 900 });
    expect(solo?.topShare).toBe(1);
    expect(shared).toMatchObject({ maintainers: 2 });
    expect(shared?.topShare).toBeCloseTo(0.5, 10);
  });

  it('files a finding for the concentrated module and NOT the shared one', async () => {
    const result = await runKnowledgeRegister({ db, workspaceId, repoId });
    expect(result.status).toBe('succeeded');
    expect(result.findings).toBe(1);

    const rows = await db
      .select()
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimension).toBe('knowledge');
    // The MODULE is the location: a directory, not an arbitrary file inside it.
    expect(rows[0]?.file).toBe('src/solo');
    expect(rows[0]?.lineStart).toBeNull();
  });

  it('stores NO identity anywhere in the row (N-9), checked against the DB', async () => {
    // The strongest form of the N-9 check: the login exists in this database,
    // in identities, and must not have travelled into the finding.
    const rows = await db
      .select()
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    const payload = JSON.stringify(rows).toLowerCase();
    expect(payload).not.toContain('w10-01-solo');
    expect(payload).not.toContain('w10-01-other');
    expect(payload).not.toContain('@');
  });

  it('re-running creates ZERO new rows', async () => {
    const before = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const result = await runKnowledgeRegister({ db, workspaceId, repoId });
    expect(result.created).toBe(0);
    const after = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(after.length).toBe(before.length);
  });

  it('D12: the same concentration bands lower on a COLD module', async () => {
    // FR-REG-1's floor test, through the real pricer: identical finding,
    // different exposure. The cold one must rank below AND remain visible.
    const hot = priceFinding({
      dimension: 'knowledge' as never,
      severity: 3,
      confidence: 5,
      verifyStatus: 'confirmed',
      ruleFpRate: 0,
      hotspotPercentile: 1,
    });
    const cold = priceFinding({
      dimension: 'knowledge' as never,
      severity: 3,
      confidence: 5,
      verifyStatus: 'confirmed',
      ruleFpRate: 0,
      hotspotPercentile: 0,
    });
    expect(hot.effectiveRisk).toBeGreaterThan(cold.effectiveRisk);
    expect(['act', 'schedule']).toContain(hot.band);
    expect(cold.band).toBe('track');
    expect(cold.effectiveRisk).toBeGreaterThan(0);
  });
});
