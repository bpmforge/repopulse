import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
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
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: WS_SLUG, name: 'W20-06 analysis' };
      request.role = 'admin';
    });
    await app.register(analysisAdminRoutes, { db });
    await app.ready();
  });

  const clear = () =>
    db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, workspaceId));

  beforeEach(clear);

  afterAll(async () => {
    await clear();
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
});
