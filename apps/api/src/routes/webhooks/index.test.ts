import 'dotenv/config';
import { createHmac, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import webhookRoutes from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const WH_SECRET = 'per-connection-webhook-secret-xyz';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describeIfLiveInfra('webhook receiver (W2-04, SC-3/SC-4, FR-INGEST-5/6)', () => {
  const db: Database = createDb(databaseUrl as string);
  const tokenKey = randomBytes(32);
  const enqueueDelta = vi.fn(async (_spec: { data: { kind: string } }) => {});
  const onInvalidSignature = vi.fn();
  let app: FastifyInstance;
  let workspaceId: number;

  const payload = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/hooked' },
    number: 1,
  });

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-04-hook', name: 'w2-04-hook' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-04-hook' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w2-04-hook-user', login: 'w2-04-hook-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-04-hook-user' } })
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
        // the sealed webhook secret the receiver decrypts to verify
        webhookSecretCiphertext: credentials.sealSecret(WH_SECRET, tokenKey),
      })
      .returning();
    await db.insert(core.repos).values({
      workspaceId,
      connectionId: conn!.id,
      forgeRepoId: 'r-hooked',
      org: 'acme',
      name: 'hooked',
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    });

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(webhookRoutes, { db, tokenKey, enqueueDelta, onInvalidSignature });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-04-hook-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  beforeEach(() => {
    enqueueDelta.mockClear();
    onInvalidSignature.mockClear();
  });

  function post(headers: Record<string, string>, body = payload) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });
  }

  it('valid signature + new delivery → 202 and a delta enqueued', async () => {
    const res = await post({
      'x-hub-signature-256': sign(payload, WH_SECRET),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-A',
    });
    expect(res.statusCode).toBe(202);
    expect(enqueueDelta).toHaveBeenCalledTimes(1);
    expect(enqueueDelta.mock.calls[0]![0]).toMatchObject({ data: { kind: 'pull_requests' } });
  });

  it('tampered signature → 401 and nothing enqueued', async () => {
    const res = await post({
      'x-hub-signature-256': sign(payload, 'wrong-secret'),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-B',
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
    expect(onInvalidSignature).toHaveBeenCalled();
  });

  it('missing signature header → 401', async () => {
    const res = await post({ 'x-github-event': 'push', 'x-github-delivery': 'delivery-C' });
    expect(res.statusCode).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it('duplicate delivery_id → 200 no-op, no second enqueue (SC-4 replay guard)', async () => {
    const headers = {
      'x-hub-signature-256': sign(payload, WH_SECRET),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-D',
    };
    const first = await post(headers);
    expect(first.statusCode).toBe(202);
    enqueueDelta.mockClear();
    const second = await post(headers); // GitHub redelivery
    expect(second.statusCode).toBe(200);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it('untracked repo → 401 (no secret to verify against)', async () => {
    const other = JSON.stringify({ repository: { full_name: 'acme/not-tracked' } });
    const res = await post(
      {
        'x-hub-signature-256': sign(other, WH_SECRET),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-E',
      },
      other,
    );
    expect(res.statusCode).toBe(401);
  });
});
