import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import analysisAdminRoutes from './index.js';
import errorEnvelopePlugin from '../../../plugins/error-envelope.js';

// W20-06 (UX_TODO AI-86). The reassurance line at the top of Admin → Analysis
// must say what leaves the network by WHERE each endpoint is (the egress audit's
// rule), not by the allow_public_host flag, and must name what is off-network.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const WS_SLUG = 'w20-06-analysis';

describeIfLiveInfra('Admin → Analysis gateway line (W20-06)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  let workspaceId = 0;
  let connectionId = 0;
  let repoId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: WS_SLUG, name: 'W20-06 analysis' })
      .onConflictDoNothing()
      .returning({ id: core.workspaces.id });
    workspaceId =
      ws?.id ??
      (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, WS_SLUG))
      )[0]!.id;
    // A repository for the egress audit rows (W20-11).
    const enc = credentials.encryptCredential('w20-11-analysis-token', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w20-11-analysis-repo',
        org: 'acme',
        name: 'api',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = repo!.id;
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: WS_SLUG, name: 'W20-06 analysis' };
      request.role = 'admin';
    });
    await app.register(analysisAdminRoutes, { db });
    await app.ready();
  });

  const clear = async () => {
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, workspaceId));
    await db.delete(read.egressAudit).where(eq(read.egressAudit.workspaceId, workspaceId));
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    if (repoId) await db.delete(core.repos).where(eq(core.repos.id, repoId));
    if (connectionId)
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await app?.close();
    if (workspaceId) await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  const add = (v: {
    name: string;
    kind: string;
    baseUrl: string | null;
    allowPublicHost: boolean;
  }) => db.insert(core.llmProviders).values({ workspaceId, model: 'm', enabled: true, ...v });

  it('counts a Claude Code CLI connection as off-network, though its allow_public_host is false', async () => {
    await add({
      name: 'LM Studio',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:1234/v1',
      allowPublicHost: false,
    });
    await add({
      name: 'Claude Code CLI',
      kind: 'claude_cli',
      baseUrl: null,
      allowPublicHost: false,
    });
    const gw = (await app.inject({ method: 'GET', url: '/admin/analysis' })).json().gateway;
    expect(gw).toMatchObject({
      configured: true,
      provider_count: 2,
      off_network: true,
      off_network_names: ['Claude Code CLI'],
    });
  });

  it('names every off-network connection, and says none when all are on the network', async () => {
    await add({
      name: 'LAN',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:1234/v1',
      allowPublicHost: false,
    });
    let gw = (await app.inject({ method: 'GET', url: '/admin/analysis' })).json().gateway;
    expect(gw.off_network).toBe(false);
    expect(gw.off_network_names).toEqual([]);

    await add({ name: 'Gemini', kind: 'gemini', baseUrl: null, allowPublicHost: true });
    await add({
      name: 'Named host',
      kind: 'openai_compatible',
      baseUrl: 'http://gpu-box.lan:1234/v1',
      allowPublicHost: false,
    });
    gw = (await app.inject({ method: 'GET', url: '/admin/analysis' })).json().gateway;
    expect(gw.off_network_names).toEqual(['Gemini', 'Named host']);
  });
  // W20-11 (UX_TODO AI-79, AI-29 partial, AI-80 partial): the gateway writes an
  // `attempted` row and an outcome row per request; the screen counts and lists
  // each request once, with its outcome, and a refusal apart (nothing was sent).
  it('counts and lists each request once, with its outcome, and refusals apart', async () => {
    const row = (v: Partial<typeof read.egressAudit.$inferInsert>) => ({
      workspaceId,
      repoId,
      modelId: 'gemini-2.5-flash',
      bytesSent: 2048,
      contentSha256: 'sha',
      destinationHost: 'generativelanguage.googleapis.com',
      tier: 2,
      ...v,
    });
    await db
      .insert(read.egressAudit)
      .values([
        row({ attemptId: 'a1', outcome: 'attempted' }),
        row({ attemptId: 'a1', outcome: 'succeeded', tokensSent: 500, tokensReceived: 40 }),
        row({ attemptId: 'a2', outcome: 'attempted' }),
        row({ attemptId: 'a2', outcome: 'failed', error: 'timeout' }),
        row({ attemptId: 'a3', outcome: 'attempted' }),
        row({ attemptId: 'd1', outcome: 'denied', bytesSent: 0, error: 'local only' }),
      ]);
    const body = (await app.inject({ method: 'GET', url: '/admin/analysis' })).json();
    const mine = body.repos.find((r: { id: number }) => r.id === repoId);
    expect(mine.egress).toMatchObject({ calls: 3, bytes: 3 * 2048, tokens_sent: 500, refused: 1 });
    expect(body.egress_total).toBe(4);
    expect(body.egress_log.map((e: { outcome: string }) => e.outcome)).toEqual([
      'denied',
      'pending',
      'failed',
      'succeeded',
    ]);
    expect(body.egress_log[3]).toMatchObject({
      repo: 'acme/api',
      host: 'generativelanguage.googleapis.com',
      tokens_sent: 500,
      tokens_received: 40,
    });

    const filtered = (
      await app.inject({ method: 'GET', url: `/admin/analysis?repo_id=${repoId + 100000}` })
    ).json();
    expect(filtered.egress_log).toEqual([]);
    const older = (
      await app.inject({
        method: 'GET',
        url: `/admin/analysis?before=${body.egress_log[1].id}`,
      })
    ).json();
    expect(older.egress_log.map((e: { outcome: string }) => e.outcome)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect((await app.inject({ method: 'GET', url: '/admin/analysis?before=x' })).statusCode).toBe(
      400,
    );
  });
});
