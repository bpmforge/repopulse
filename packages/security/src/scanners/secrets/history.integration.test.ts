import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { historyTargets, runSecretsHistoryScan, windowStart } from './history.js';

// History mode (W8-05, SECURITY_SUITE.md 3.1, FR-SEC-4).
//
// The leak this exists for: a credential committed in an old commit and deleted
// later. Stream mode never saw it (it predates the webhook) and the current
// tree does not contain it — so the ONLY way to find it is to look at history.
// The test plants exactly that shape: the secret appears in one old commit's
// patch and in no other.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const PLANTED = 'AKIAW8O5HISTORYKEY99';
const OLD_SHA = 'w8-05-old-commit-sha-000000000000000000';
const RECENT_SHA = 'w8-05-recent-commit-sha-0000000000000';
const ANCIENT_SHA = 'w8-05-ancient-commit-sha-000000000000';
const FP = 'w8-05-history-fp';

const OLD_PATCH = [
  '@@ -1,2 +1,3 @@',
  ' const region = "us-east-1";',
  `+const accessKeyId = "${PLANTED}";`,
].join('\n');

// The commit that removed it. Nothing here should be reported: a removed line
// is a key that was already committed, and the finding belongs to the commit
// that added it.
const RECENT_PATCH = [
  '@@ -1,3 +1,2 @@',
  ' const region = "us-east-1";',
  `-const accessKeyId = "${PLANTED}";`,
].join('\n');

function fakeProvider(calls: { sha: string; lane: string }[]): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getCommitFiles: async (ctx: CallCtx, _repo: string, sha: string) => {
      calls.push({ sha, lane: ctx.lane });
      const patch = sha === OLD_SHA ? OLD_PATCH : RECENT_PATCH;
      return {
        items: [{ path: 'src/s3.ts', patch, status: 'modified' }],
        stats: { additions: 1, deletions: 0 },
      };
    },
  } as unknown as ForgeProvider;
}

describe('the history window', () => {
  it('reaches back the configured number of months', () => {
    const now = new Date('2026-08-19T00:00:00Z');
    expect(windowStart(12, now).toISOString().slice(0, 10)).toBe('2025-08-19');
    expect(windowStart(1, now).toISOString().slice(0, 10)).toBe('2026-07-19');
  });
});

describeIfLiveInfra('secrets history mode (W8-05)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
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
      .values({ authProvider: 'github', authSubject: 'w8-05-user', forgeUserId: 'w8-05-user', login: 'w8-05-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-05-user' } })
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
        forgeRepoId: 'w8-05-repo',
        org: 'acme',
        name: 'secrets-history',
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
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w8-05-author',
        displayName: 'W8-05 Author',
      })
      .returning();
    identityId = identity!.id;

    const commit = (sha: string, monthsAgo: number) => {
      const at = new Date();
      at.setMonth(at.getMonth() - monthsAgo);
      return {
        workspaceId,
        repoId,
        sha,
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        messageHead: `commit ${sha}`,
        committedAt: at,
        authoredAt: at,
        additions: 1,
        deletions: 0,
        isRevertHeuristic: false,
        isMerge: false,
      };
    };

    await db.insert(facts.commits).values([
      commit(OLD_SHA, 6),
      commit(RECENT_SHA, 1),
      // Outside the 12-month window: history mode must not reach it, or the
      // "12-month window" in the design is decoration.
      commit(ANCIENT_SHA, 20),
    ]);
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(facts.commits).where(eq(facts.commits.repoId, repoId));
    await db.delete(core.identities).where(eq(core.identities.id, identityId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('picks unscanned commits inside the window, OLDEST first', async () => {
    // Oldest first because history exists to reach the far end of the window;
    // newest-first would spend every capped sweep re-walking what stream mode
    // has already covered.
    const targets = await historyTargets(db, workspaceId, repoId, { limit: 10 });
    expect(targets.map((t) => t.commitSha)).toEqual([OLD_SHA, RECENT_SHA]);
  });

  it('finds a secret that exists ONLY in an old commit', async () => {
    const calls: { sha: string; lane: string }[] = [];
    const result = await runSecretsHistoryScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-history',
    });

    expect(result.scanned).toBe(2);
    expect(result.findingsCreated).toBe(1);
    // Every patch fetch is on the scan lane, and the ancient commit is never
    // fetched at all — the window is a real filter, not a label.
    expect(calls.map((c) => c.lane)).toEqual(['scan', 'scan']);
    expect(calls.map((c) => c.sha)).not.toContain(ANCIENT_SHA);

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'secrets')));
    expect(row?.ruleId).toBe('aws-access-key-id');
    expect(row?.file).toBe('src/s3.ts');
    // Recorded against a scheduled run, so the Security tab can say where a
    // finding came from: a nightly sweep is not a pull request.
    const runs = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.repoId, repoId));
    expect(runs.every((r) => r.trigger === 'schedule')).toBe(true);
    expect(runs.map((r) => r.status).every((s) => s === 'succeeded')).toBe(true);
  });

  it('re-running over unchanged history creates ZERO new rows', async () => {
    // Both halves matter: the commits are already covered so nothing is
    // re-fetched, and even a forced re-scan would land on the same dedup key.
    const before = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));

    const calls: { sha: string; lane: string }[] = [];
    const again = await runSecretsHistoryScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-history',
    });
    expect(again.skipped).toBe('no_targets');
    expect(calls).toEqual([]);

    const after = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(after.length).toBe(before.length);
  });

  it('a commit stuck in `running` is skipped, and `force` re-sweeps it (W23-09)', async () => {
    // A worker that died mid-scan leaves a `running` row, and the covered filter
    // counts `running` as covered: without a way around it the commit is never
    // looked at again.
    await db
      .update(security.scanRuns)
      .set({ status: 'running', finishedAt: null })
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.scannerKey, 'secrets'),
          eq(security.scanRuns.commitSha, OLD_SHA),
        ),
      );

    const plainCalls: { sha: string; lane: string }[] = [];
    const plain = await runSecretsHistoryScan({
      db,
      provider: fakeProvider(plainCalls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-history',
    });
    expect(plain.skipped).toBe('no_targets');
    expect(plainCalls).toEqual([]);

    const forcedCalls: { sha: string; lane: string }[] = [];
    const forced = await runSecretsHistoryScan({
      db,
      provider: fakeProvider(forcedCalls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-history',
      force: true,
    });
    expect(forced.skipped).toBeUndefined();
    expect(forcedCalls.map((c) => c.sha)).toContain(OLD_SHA);
    // Still on the budgeted scan lane (Law 7): force changes WHICH commits, not how they are fetched.
    expect(forcedCalls.every((c) => c.lane === 'scan')).toBe(true);
  });

  it('reports what it DEFERRED when the cap bites', async () => {
    // A silent cap reads as "history is clean" when it means "history is
    // half-read". Clearing the scan runs makes both commits pending again —
    // findings first, because since W8-04 a finding points at the run that
    // produced it and the FK will not let the parent go.
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    const result = await runSecretsHistoryScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/secrets-history',
      maxCommits: 1,
    });
    expect(result.scanned).toBe(1);
    expect(result.deferred).toBe(1);
  });
});
