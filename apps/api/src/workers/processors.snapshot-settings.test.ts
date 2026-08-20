import 'dotenv/config';
import type { Job } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { core, facts, read, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotProcessor, type ProcessorDeps } from './processors.js';
import { readWorkspaceSettings } from '../lib/workspace-settings.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// W4-09 acceptance 2: a changed setting must reach the NEXT snapshot.
//
// Stale-N is the cheapest honest proof — one setting, one metric (M8), no
// enrichment needed — and it fails loudly if the processor goes back to
// ignoring settings. The bot-list half of the same wiring is covered by the
// `[]`-vs-unset unit tests in lib/workspace-settings.test.ts, since the two
// values travel through this identical call.

describeIfLiveInfra('snapshot processor reads workspace settings (W4-09)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;
  let repoId: number;
  let identityId: number;

  const deps = { db } as unknown as ProcessorDeps;
  const run = () => snapshotProcessor(deps)({ data: { workspaceId, repoId } } as unknown as Job);

  async function latestM8(): Promise<number> {
    const [row] = await db
      .select({ value: read.metricSnapshots.value })
      .from(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.repoId, repoId),
          eq(read.metricSnapshots.metricKey, 'M8'),
          eq(read.metricSnapshots.window, '30d'),
        ),
      )
      .orderBy(desc(read.metricSnapshots.computedAt), desc(read.metricSnapshots.id))
      .limit(1);
    return Number(row?.value ?? -1);
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    await db
      .update(core.workspaces)
      .set({ settings: {} })
      .where(eq(core.workspaces.id, workspaceId));

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w4-09-snap', forgeUserId: 'w4-09-snap', login: 'w4-09-snap' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w4-09-snap' } })
      .returning();

    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.alloc(8),
        credentialIv: Buffer.alloc(12),
        keyVersion: 1,
        credentialFingerprint: 'w4-09-snap-fingerprint',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w4-09-snap-repo',
        org: 'w4-09-org',
        name: 'stale',
        defaultBranch: 'main',
        isPrivate: false,
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
        forgeLogin: 'w4-09-author',
        displayName: 'w4-09-author',
        isBot: false,
      })
      .returning();
    identityId = identity!.id;

    // Open, not draft, last touched 14 days ago: stale at the default N=7,
    // NOT stale at N=30. One PR sitting between the two thresholds is what
    // makes the assertion below distinguish a real read from a hardcoded value.
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await db.insert(facts.pullRequests).values({
      workspaceId,
      repoId,
      number: 1,
      forgePrId: 'w4-09-pr-1',
      title: 'quietly waiting',
      authorIdentityId: identityId,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: fourteenDaysAgo,
      updatedAt: fourteenDaysAgo,
      baseRef: 'main',
      headSha: 'deadbeef',
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      lastActivityAt: fourteenDaysAgo,
    });
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.forgeRepoId, 'w4-09-snap-repo'));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, 'w4-09-snap-fingerprint'));
    await db.delete(core.identities).where(eq(core.identities.id, identityId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w4-09-snap'));
    await db
      .update(core.workspaces)
      .set({ settings: {} })
      .where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('with no setting stored, the documented default N=7 applies', async () => {
    await run();
    expect(await latestM8()).toBe(1);
  });

  it('raising stale-N to 30 makes the same PR stop counting as stale', async () => {
    await db
      .update(core.workspaces)
      .set({ settings: { stale_pr_days: 30 } })
      .where(eq(core.workspaces.id, workspaceId));

    // Sanity: the reader sees the change. If this passed while the assertion
    // below failed, the settings would be readable but unwired — which is
    // exactly the state this ticket found the bot list in.
    const { effective } = await readWorkspaceSettings(db, workspaceId);
    expect(effective.stalePrDays).toBe(30);

    await run();
    expect(await latestM8()).toBe(0);
  });
});
