import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { LLM_ROLES } from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import llmRoutingRoutes from './index.js';
import { chainsFor, loadStoredRouting } from '../../../lib/llm-routing.js';
import errorEnvelopePlugin from '../../../plugins/error-envelope.js';

// W19-02. Per-role routing and the local-only switch.
//
// What matters here: a chain that would leave the network is refused WITH THE
// ROLE AND CONNECTION NAMED; settings are workspace-scoped (Law 5); a deleted
// connection leaves its chains rather than dangling; and a routed role whose
// connections are all gone refuses instead of using some other model.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };

describeIfLiveInfra('admin LLM routing (W19-02)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  let WORKSPACE_ID = 1;
  let OTHER_ID = 0;
  let lanId = 0;
  let cloudId = 0;
  let lan2Id = 0;

  async function clear(): Promise<void> {
    for (const ws of [WORKSPACE_ID, OTHER_ID]) {
      if (!ws) continue;
      await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, ws));
      await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, ws));
      await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, ws));
    }
  }

  async function seedProviders(): Promise<void> {
    const rows = await db
      .insert(core.llmProviders)
      .values([
        {
          workspaceId: WORKSPACE_ID,
          name: 'LAN',
          kind: 'openai_compatible',
          baseUrl: 'http://10.0.0.5:1234/v1',
          model: 'lan-m',
        },
        {
          workspaceId: WORKSPACE_ID,
          name: 'LAN2',
          kind: 'openai_compatible',
          baseUrl: 'http://10.0.0.6:1234/v1',
          model: 'lan2-m',
        },
        {
          workspaceId: WORKSPACE_ID,
          name: 'Hosted',
          kind: 'openai_compatible',
          baseUrl: 'https://api.example-llm.com/v1',
          model: 'cloud-m',
          allowPublicHost: true,
        },
      ])
      .returning({ id: core.llmProviders.id, name: core.llmProviders.name });
    lanId = rows.find((r) => r.name === 'LAN')!.id;
    lan2Id = rows.find((r) => r.name === 'LAN2')!.id;
    cloudId = rows.find((r) => r.name === 'Hosted')!.id;
  }

  beforeAll(async () => {
    const [ws] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    if (!ws || !user) throw new Error('seed the warehouse first: pnpm seed');
    WORKSPACE_ID = ws.id;
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-02-other-tenant', name: 'Other tenant' })
      .onConflictDoNothing();
    const [other] = await db
      .select({ id: core.workspaces.id })
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, 'w19-02-other-tenant'))
      .limit(1);
    OTHER_ID = other!.id;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: ws.id, slug: 'test', name: 'test' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? user.id : undefined),
      };
    });
    await app.register(llmRoutingRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await clear();
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER_ID));
    await app.close();
    await db.$client.end();
  });

  beforeEach(async () => {
    await clear();
    await seedProviders();
  });

  const put = (payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/admin/llm-routing',
      headers: CSRF,
      payload: payload as object,
    });
  const get = () => app.inject({ method: 'GET', url: '/admin/llm-routing' });

  it('keeps the shared role list equal to the analysis one', () => {
    expect([...core.LLM_ROLES]).toEqual([...LLM_ROLES]);
  });

  it('saves an ordered chain per role and reads it back in order', async () => {
    const res = await put({
      local_only: false,
      roles: {
        security: [{ provider_id: cloudId, model: 'big' }, { provider_id: lanId }],
        triage: [{ provider_id: lan2Id }],
      },
    });
    expect(res.statusCode).toBe(204);
    const body = (await get()).json();
    const sec = body.roles.find((r: { role: string }) => r.role === 'security');
    expect(sec.chain).toMatchObject([
      { provider_id: cloudId, provider_name: 'Hosted', model: 'big' },
      { provider_id: lanId, provider_name: 'LAN', model: null },
    ]);
    expect(body.roles).toHaveLength(LLM_ROLES.length);
    expect(JSON.stringify(body)).not.toMatch(/credential|api_key/);
  });

  it('local-only refuses a chain that leaves the network, naming role and connection', async () => {
    const res = await put({
      local_only: true,
      roles: { patch: [{ provider_id: lanId }, { provider_id: cloudId }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe(
      'Local-only is on: role "patch" would send to connection "Hosted", which is outside your network.',
    );
    // Nothing was saved.
    expect((await loadStoredRouting(db, WORKSPACE_ID)).routes).toHaveLength(0);
  });

  it('local-only accepts an all-local configuration, and can be turned on over existing chains only if they are local', async () => {
    expect(
      (await put({ local_only: false, roles: { security: [{ provider_id: cloudId }] } }))
        .statusCode,
    ).toBe(204);
    // Same chains, switch on: refused, because the saved chain would leave.
    const refused = await put({
      local_only: true,
      roles: { security: [{ provider_id: cloudId }] },
    });
    expect(refused.statusCode).toBe(422);
    const ok = await put({ local_only: true, roles: { security: [{ provider_id: lanId }] } });
    expect(ok.statusCode).toBe(204);
    expect((await loadStoredRouting(db, WORKSPACE_ID)).localOnly).toBe(true);
  });

  it('rejects an unknown role, a missing connection, a disabled one and a duplicate link', async () => {
    expect((await put({ local_only: false, roles: { nope: [] } })).statusCode).toBe(400);
    expect(
      (await put({ local_only: false, roles: { security: [{ provider_id: 999999 }] } })).statusCode,
    ).toBe(400);
    await db
      .update(core.llmProviders)
      .set({ enabled: false })
      .where(eq(core.llmProviders.id, lan2Id));
    const disabled = await put({
      local_only: false,
      roles: { security: [{ provider_id: lan2Id }] },
    });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().title).toMatch(/disabled/);
    const dup = await put({
      local_only: false,
      roles: { security: [{ provider_id: lanId }, { provider_id: lanId }] },
    });
    expect(dup.statusCode).toBe(400);
  });

  it("never reads or writes another workspace's routing — Law 5", async () => {
    await put({ local_only: true, roles: { security: [{ provider_id: lanId }] } });
    const theirs = await loadStoredRouting(db, OTHER_ID);
    expect(theirs).toEqual({ localOnly: false, routes: [] });

    // A provider id from ANOTHER workspace is simply not a connection here.
    const [foreign] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: OTHER_ID,
        name: 'Foreign',
        kind: 'openai_compatible',
        baseUrl: 'http://10.0.0.9:1234/v1',
        model: 'f',
      })
      .returning({ id: core.llmProviders.id });
    const res = await put({
      local_only: false,
      roles: { security: [{ provider_id: foreign!.id }] },
    });
    expect(res.statusCode).toBe(400);
    expect((await get()).json().providers.map((p: { name: string }) => p.name)).not.toContain(
      'Foreign',
    );
  });

  it('a deleted connection leaves its chains instead of dangling', async () => {
    await put({
      local_only: false,
      roles: { security: [{ provider_id: lanId }, { provider_id: lan2Id }] },
    });
    await db.delete(core.llmProviders).where(eq(core.llmProviders.id, lanId));
    const sec = (await get()).json().roles.find((r: { role: string }) => r.role === 'security');
    expect(sec.chain.map((c: { provider_id: number }) => c.provider_id)).toEqual([lan2Id]);
  });

  it('builds worker chains with the per-role model, and an EMPTY chain for a role whose connections are gone', async () => {
    await put({
      local_only: false,
      roles: {
        security: [{ provider_id: lanId, model: 'override' }],
        triage: [{ provider_id: lan2Id }],
      },
    });
    const stored = await loadStoredRouting(db, WORKSPACE_ID);
    const hosts = [
      { baseUrl: 'http://10.0.0.5:1234/v1', modelSlot: 'lan-m', providerId: lanId, name: 'LAN' },
    ];
    const chains = chainsFor(stored, hosts);
    expect(chains.security?.[0]?.host.modelSlot).toBe('override');
    // triage is routed to LAN2, which did not resolve: empty, not absent.
    expect(chains.triage).toEqual([]);
    expect(chains.patch).toBeUndefined();
  });

  it("carries a connection's probed context window onto its host (W19-03)", async () => {
    await db
      .update(core.llmProviders)
      .set({ capabilities: { contextWindow: 32768, streaming: 'yes' } })
      .where(eq(core.llmProviders.id, lanId));
    const { hostsFromProviders } = await import('../../../workers/gateway.js');
    const { hosts } = await hostsFromProviders(db, Buffer.alloc(32, 7), WORKSPACE_ID);
    expect(hosts.find((h) => h.providerId === lanId)?.contextWindow).toBe(32768);
    expect(hosts.find((h) => h.providerId === lan2Id)?.contextWindow).toBeUndefined();
  });

  it('says, per connection and per chain link, which host it talks to and whether that leaves the network (W19-07)', async () => {
    await put({
      local_only: false,
      roles: { security: [{ provider_id: cloudId }, { provider_id: lanId }] },
    });
    const body = (await get()).json();
    const byName = (n: string) => body.providers.find((p: { name: string }) => p.name === n);
    expect(byName('LAN')).toMatchObject({ host: '10.0.0.5:1234', leaves_network: false });
    expect(byName('Hosted')).toMatchObject({ host: 'api.example-llm.com', leaves_network: true });
    const sec = body.roles.find((r: { role: string }) => r.role === 'security');
    expect(sec.chain.map((c: { leaves_network: boolean }) => c.leaves_network)).toEqual([
      true,
      false,
    ]);
    // Never a path, key or header: only a host.
    expect(JSON.stringify(body)).not.toMatch(/\/v1|api_key|credential/);
  });

  it('a vendor with a fixed endpoint reports that endpoint, not "unknown"', async () => {
    await db.insert(core.llmProviders).values({
      workspaceId: WORKSPACE_ID,
      name: 'Gem',
      kind: 'gemini',
      baseUrl: null,
      model: 'gemini-2.5-flash',
      allowPublicHost: true,
    });
    const gem = (await get()).json().providers.find((p: { name: string }) => p.name === 'Gem');
    expect(gem).toMatchObject({ host: 'generativelanguage.googleapis.com', leaves_network: true });
  });
});
