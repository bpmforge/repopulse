import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMMUTABLE_TABLES,
  pruneForgeEtag,
  pruneWebhookDelivery,
  SWEEPABLE_TABLES,
} from './sweeps.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const NOW = Date.parse('2026-07-19T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describe('retention immutability constants (SRS §5 A3, NFR-9)', () => {
  it('never lists reports or egress_audit as sweepable', () => {
    expect(IMMUTABLE_TABLES).toEqual(['reports', 'egress_audit']);
    for (const t of IMMUTABLE_TABLES) expect(SWEEPABLE_TABLES).not.toContain(t);
    expect([...SWEEPABLE_TABLES]).toEqual(['metric_snapshots', 'forge_etag', 'webhook_delivery']);
  });
});

// forge_etag + webhook_delivery sweeps. (metric_snapshots is pruned by
// @repopulse/metrics — ingest may not import metrics per ARCHITECTURE §3, so
// that sweep is tested in packages/metrics/src/retention.)
describeIfLiveInfra('ingest retention sweeps (W3-13, DATABASE §4, NFR-11)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;
  let userId: number;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-13-ret', name: 'w3-13-ret' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-13-ret' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w3-13-user', login: 'w3-13-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w3-13-user' } })
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
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: userId,
      })
      .returning();
    connectionId = conn!.id;

    await db.insert(core.forgeEtag).values([
      { workspaceId, connectionId, endpointKey: 'old', etag: 'e1', fetchedAt: daysAgo(91) },
      { workspaceId, connectionId, endpointKey: 'new', etag: 'e2', fetchedAt: daysAgo(10) },
    ]);
    await db.insert(core.webhookDelivery).values([
      {
        workspaceId,
        connectionId,
        deliveryId: 'w3-13-old',
        event: 'push',
        repoFullName: 'a/b',
        payloadDigest: 'd',
        receivedAt: daysAgo(31),
      },
      {
        workspaceId,
        connectionId,
        deliveryId: 'w3-13-new',
        event: 'push',
        repoFullName: 'a/b',
        payloadDigest: 'd',
        receivedAt: daysAgo(5),
      },
    ]);
    // a reports row — MUST survive every sweep (immutability).
    await db
      .insert(read.reports)
      .values({
        workspaceId,
        type: 'repo_health',
        params: {},
        status: 'ready',
        generatedBy: userId,
      });
  });

  afterAll(async () => {
    await db.delete(core.forgeEtag).where(eq(core.forgeEtag.workspaceId, workspaceId));
    await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.workspaceId, workspaceId));
    await db.delete(read.reports).where(eq(read.reports.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w3-13-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  const counts = async () => ({
    etag: (
      await db.select().from(core.forgeEtag).where(eq(core.forgeEtag.workspaceId, workspaceId))
    ).length,
    webhooks: (
      await db
        .select()
        .from(core.webhookDelivery)
        .where(eq(core.webhookDelivery.workspaceId, workspaceId))
    ).length,
    reports: (await db.select().from(read.reports).where(eq(read.reports.workspaceId, workspaceId)))
      .length,
  });

  it('sweeps out-of-policy etag/webhook rows, keeps in-policy, never touches reports', async () => {
    const opts = { nowMs: NOW };
    expect(await pruneWebhookDelivery(db, opts)).toBe(1); // 31d gone
    expect(await pruneForgeEtag(db, opts)).toBe(1); // 91d gone
    const c = await counts();
    expect(c.etag).toBe(1);
    expect(c.webhooks).toBe(1);
    expect(c.reports).toBe(1); // NEVER touched
  });

  it('is idempotent — a second run deletes nothing more', async () => {
    const opts = { nowMs: NOW };
    expect(await pruneWebhookDelivery(db, opts)).toBe(0);
    expect(await pruneForgeEtag(db, opts)).toBe(0);
    expect(await counts()).toMatchObject({ etag: 1, webhooks: 1, reports: 1 });
  });
});
