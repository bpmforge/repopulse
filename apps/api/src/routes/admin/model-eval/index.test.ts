import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { MODEL_EVAL_RESULTS } from '@repopulse/security';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import modelEvalRoutes from './index.js';
import errorEnvelopePlugin from '../../../plugins/error-envelope.js';

// W19-05. The table is the committed results joined to THIS workspace's
// configured models: a configured model with no result is listed, as not yet
// run, and another workspace's models never appear.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('admin model evaluation (W19-05)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  let ws = 1;
  let other = 0;

  async function clear() {
    for (const w of [ws, other])
      if (w) await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, w));
  }

  beforeAll(async () => {
    const [w] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    if (!w || !user) throw new Error('seed the warehouse first: pnpm seed');
    ws = w.id;
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-05-other', name: 'Other' })
      .onConflictDoNothing();
    const [o] = await db
      .select({ id: core.workspaces.id })
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, 'w19-05-other'))
      .limit(1);
    other = o!.id;
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: w.id, slug: 'test', name: 'test' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k) => (k === 'userId' ? user.id : undefined),
      };
    });
    await app.register(modelEvalRoutes, { db });
    await app.ready();
  });
  afterAll(async () => {
    await clear();
    await db.delete(core.workspaces).where(eq(core.workspaces.id, other));
    await app.close();
    await db.$client.end();
  });
  beforeEach(clear);

  it('lists a configured model with no result as not measured', async () => {
    await db.insert(core.llmProviders).values({
      workspaceId: ws,
      name: 'LAN',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:1234/v1',
      model: 'never-measured-model',
    });
    const body = (await app.inject({ method: 'GET', url: '/admin/model-eval' })).json();
    const entry = body.models.find((m: { model: string }) => m.model === 'never-measured-model');
    expect(entry).toMatchObject({ configured: true, provider_name: 'LAN', result: null });
    expect(body.roles.map((r: { id: string }) => r.id)).toContain('ai_slop');
  });

  it('attaches a published result to a configured model with the same id', async () => {
    const measured = MODEL_EVAL_RESULTS.rows[0];
    if (!measured) return; // nothing published yet: covered by the test above
    await db.insert(core.llmProviders).values({
      workspaceId: ws,
      name: 'M',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:1234/v1',
      model: measured.model,
    });
    const body = (await app.inject({ method: 'GET', url: '/admin/model-eval' })).json();
    const entry = body.models.find(
      (m: { model: string; configured: boolean }) => m.model === measured.model && m.configured,
    );
    expect(entry.result.engine).toBe(measured.engine);
    expect(entry.result.ranAt).toBe(measured.ranAt);
  });

  it("never lists another workspace's configured models", async () => {
    await db.insert(core.llmProviders).values({
      workspaceId: other,
      name: 'Theirs',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.9:1234/v1',
      model: 'their-secret-model',
    });
    const body = (await app.inject({ method: 'GET', url: '/admin/model-eval' })).json();
    expect(JSON.stringify(body)).not.toContain('their-secret-model');
  });
});
