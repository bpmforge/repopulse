import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankHotspots } from './ranking.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const ASOF = new Date('2026-07-07T00:00:00Z');

describeIfLiveInfra('cross-repo hotspot ranking (W3-11, FR-INSIGHTS-5)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoA: number;
  let repoB: number;

  async function seedCommit(
    repoId: number,
    identityId: number,
    sha: string,
    path: string,
    add: number,
    del: number,
    at: Date,
  ) {
    const [c] = await db
      .insert(facts.commits)
      .values({
        workspaceId,
        repoId,
        sha,
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: at,
        committedAt: at,
        messageHead: 'x',
        isRevertHeuristic: false,
        isMerge: false,
      })
      .returning();
    await db
      .insert(facts.commitFiles)
      .values({
        workspaceId,
        repoId,
        commitId: c!.id,
        path,
        additions: add,
        deletions: del,
        status: 'modified',
      });
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-11-hot', name: 'w3-11-hot' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-11-hot' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w3-11-hot-user', forgeUserId: 'w3-11-hot-user', login: 'w3-11-hot-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w3-11-hot-user' } })
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
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [id] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'alice', displayName: 'alice' })
      .returning();
    const mk = async (name: string) =>
      (
        await db
          .insert(core.repos)
          .values({
            workspaceId,
            connectionId: conn!.id,
            forgeRepoId: name,
            org: 'acme',
            name,
            defaultBranch: 'main',
            isPrivate: true,
            isArchived: false,
            syncStatus: 'live',
            tier2Auto: false,
          })
          .returning()
      )[0]!.id;
    repoA = await mk('repo-a');
    repoB = await mk('repo-b');
    // E1: api.ts (+120/-40 on 07-05) hotter than util.ts (+20/-10 on 06-10).
    await seedCommit(repoA, id!.id, 'a1', 'api.ts', 120, 40, new Date('2026-07-05T00:00:00Z'));
    await seedCommit(repoA, id!.id, 'a2', 'util.ts', 20, 10, new Date('2026-06-10T00:00:00Z'));
    // repo B has a milder hotspot.
    await seedCommit(repoB, id!.id, 'b1', 'lib.ts', 40, 10, new Date('2026-07-01T00:00:00Z'));
  });

  afterAll(async () => {
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w3-11-hot-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('ranks hotspots globally across repos with score components', async () => {
    const ranked = await rankHotspots(db, {
      repoIds: [repoA, repoB],
      asOf: ASOF,
      windowDays: 30,
      topN: 5,
    });
    // api.ts (repoA) is the global #1 (E1 score ≈ 0.955).
    expect(ranked[0]).toMatchObject({ repoId: repoA, path: 'api.ts' });
    expect(ranked[0]!.score).toBeCloseTo(0.955, 2);
    // components present for drill-down
    expect(ranked[0]).toHaveProperty('gross');
    expect(ranked[0]).toHaveProperty('decay');
    // scores are globally sorted descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    // both repos contributed
    expect(new Set(ranked.map((r) => r.repoId))).toContain(repoB);
  });
});
