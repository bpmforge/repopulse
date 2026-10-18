import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import llmProviderRoutes from './index.js';
import errorEnvelopePlugin from '../../../plugins/error-envelope.js';

// W16-07 (D-LLM-1). The configuration surface for bring-your-own-LLM.
//
// The two properties that matter most here are not features:
//
//   the API key is WRITE-ONLY — never returned by any route, in any shape
//   a provider that cannot work is refused when it is CREATED, not at 02:41
//
// Everything else is CRUD.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const TOKEN_KEY = Buffer.alloc(32, 7);
const CSRF = { 'x-requested-with': 'repopulse' };
let WORKSPACE_ID = 1;

describeIfLiveInfra('admin LLM providers (W16-07)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  const fetchImpl = vi.fn();

  async function clear(): Promise<void> {
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WORKSPACE_ID));
  }

  beforeAll(async () => {
    const [ws] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    if (!ws || !user) throw new Error('seed the warehouse first: pnpm seed');
    WORKSPACE_ID = ws.id;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    // requireAdmin reads request.role, which the /api/v1 plugin's preHandler
    // normally sets. Populate the same three decorations here rather than
    // stubbing the guard: the guard is imported directly by the route module,
    // so a decorator stub would not replace it — and satisfying it honestly
    // means these tests still run through the real 403 path.
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: ws.id, slug: 'test', name: 'test' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? user.id : undefined),
      };
    });
    await app.register(llmProviderRoutes, {
      db,
      tokenKey: TOKEN_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterAll(async () => {
    await clear();
    await app.close();
    await db.$client.end();
  });

  beforeEach(async () => {
    fetchImpl.mockReset();
    await clear();
  });

  async function create(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/admin/llm-providers',
      headers: CSRF,
      payload: body,
    });
  }

  it('a LAN provider needs no key, and the list never returns one', async () => {
    const made = await create({
      name: 'Workstation Ollama',
      kind: 'openai_compatible',
      base_url: 'http://192.168.1.50:11434/v1',
      model: 'qwen3-coder',
    });
    expect(made.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/admin/llm-providers' });
    const item = list.json().items[0];
    expect(item.name).toBe('Workstation Ollama');
    expect(item.credential).toBeNull();
    // The whole response body, not just the fields we thought to check: a key
    // that leaks through some field nobody remembered is exactly the failure.
    expect(list.body).not.toContain('sk-');
  });

  it('stores a hosted provider’s key encrypted and returns only a fingerprint', async () => {
    const secret = 'sk-test-abcdefghijklmnop';
    expect(
      (
        await create({
          name: 'OpenRouter',
          kind: 'openai_compatible',
          base_url: 'https://openrouter.ai/api/v1',
          model: 'qwen/qwen3-coder',
          api_key: secret,
          allow_public_host: true,
        })
      ).statusCode,
    ).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/admin/llm-providers' });
    expect(list.body).not.toContain(secret);
    expect(list.json().items[0].credential).toBeTruthy();

    // And not in the database in the clear either.
    const [row] = await db
      .select()
      .from(core.llmProviders)
      .where(eq(core.llmProviders.workspaceId, WORKSPACE_ID))
      .limit(1);
    expect(row?.credentialCiphertext?.toString('utf8')).not.toContain(secret);
  });

  it('refuses a public endpoint that has not opted in — SC-24 still applies', async () => {
    const res = await create({
      name: 'Careless',
      kind: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      api_key: 'sk-x',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail ?? res.body).toMatch(/private-range|allowPublicHosts/i);
  });

  it('refuses a hosted endpoint with no key at creation, not at 02:41', async () => {
    const res = await create({
      name: 'Keyless',
      kind: 'openai_compatible',
      base_url: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b',
      allow_public_host: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a credential smuggled into the headers bag', async () => {
    // That column is not encrypted. Accepting it would store a secret in the
    // clear while the person believed it was safe.
    const res = await create({
      name: 'Sneaky',
      kind: 'openai_compatible',
      base_url: 'http://10.0.0.5:1234/v1',
      model: 'm',
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('names the auth mechanism an unsupported kind needs', async () => {
    const res = await create({ name: 'Copilot', kind: 'copilot', model: 'gpt-4.1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/OAuth device flow/i);
  });

  it('Vertex without a service-account key is refused at creation with a sentence (W19-01)', async () => {
    const res = await create({
      name: 'Vertex',
      kind: 'vertex',
      base_url:
        'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi',
      model: 'google/gemini-2.5-flash',
      allow_public_host: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/service-account key/i);
  });

  it('creates a Gemini connection with no base URL, because its endpoint is fixed (W19-07 fix)', async () => {
    // The W19-01 migration added the kind but not the base-URL constraint's
    // allowance for it, so this was a 500 from the database.
    const res = await create({
      name: 'Gemini',
      kind: 'gemini',
      model: 'gemini-2.5-flash',
      api_key: 'AIza-test-key-not-real',
      allow_public_host: true,
    });
    expect(res.statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/admin/llm-providers' })).json();
    expect(list.items[0]).toMatchObject({ kind: 'gemini', base_url: null });
    expect(JSON.stringify(list)).not.toContain('AIza-test-key');
  });

  it('serves the local-server presets with the kinds (W19-01)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/llm-providers/kinds' });
    const ids = (res.json().presets as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual(['lmstudio', 'ollama', 'mlx', 'unsloth', 'vllm', 'litellm']);
    expect((res.json().kinds as { kind: string }[]).map((k) => k.kind)).toContain('gemini');
  });

  describe('capability probe (W19-01)', () => {
    const lan = {
      name: 'Probed',
      kind: 'openai_compatible',
      base_url: 'http://10.0.0.5:1234/v1',
      model: 'm',
    };
    const sse = () =>
      new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    const chat = (b: Record<string, unknown>) =>
      new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });

    it('stores what the probe found on the connection and lists it', async () => {
      fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/v0/models/')) return chat({ loaded_context_length: 32768 });
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.stream) return sse();
        if (body.tools)
          return chat({ choices: [{ message: { content: '', tool_calls: [{ id: '1' }] } }] });
        return chat({ choices: [{ message: { content: '{"ok":true}' } }] });
      });
      const res = await create({ ...lan, probe: true });
      expect(res.statusCode).toBe(201);
      expect(res.json().capabilities).toMatchObject({
        contextWindow: 32768,
        streaming: 'yes',
        jsonMode: 'yes',
        toolUse: 'yes',
      });
      const list = await app.inject({ method: 'GET', url: '/admin/llm-providers' });
      const item = list.json().items[0];
      expect(item.capabilities.contextWindow).toBe(32768);
      expect(item.probed_at).toBeTruthy();
      expect(JSON.stringify(list.json())).not.toMatch(/api_key|credential_ciphertext/);
    });

    it('refuses a server that cannot stream, at configuration time, with a sentence', async () => {
      fetchImpl.mockImplementation(async () => chat({ choices: [{ message: { content: 'ok' } }] }));
      const res = await create({ ...lan, probe: true });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/does not stream/);
      const list = await app.inject({ method: 'GET', url: '/admin/llm-providers' });
      expect(list.json().items).toHaveLength(0);
    });

    it('does not contact the endpoint at all unless asked to probe', async () => {
      const res = await create(lan);
      expect(res.statusCode).toBe(201);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('rejects a duplicate name rather than making the picker ambiguous', async () => {
    const body = {
      name: 'Same',
      kind: 'openai_compatible',
      base_url: 'http://10.0.0.5:1234/v1',
      model: 'm',
    };
    expect((await create(body)).statusCode).toBe(201);
    expect((await create(body)).statusCode).toBe(409);
  });

  describe('test connection', () => {
    it('reports a successful round trip with the model the endpoint actually ran', async () => {
      fetchImpl.mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'qwen3-coder-30b',
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200 },
        ),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: {
          name: 'probe',
          kind: 'openai_compatible',
          base_url: 'http://192.168.1.50:1234/v1',
          model: 'qwen3-coder',
        },
      });

      expect(res.json().ok).toBe(true);
      // Not what was asked for: a gateway may route elsewhere, and the operator
      // should learn that here rather than from a finding's provenance.
      expect(res.json().model).toBe('qwen3-coder-30b');
    });

    it("passes through the endpoint's own error text", async () => {
      // "Invalid API key", "model not found" and a refused connection are three
      // different problems with three different fixes. Collapsing them into
      // "connection failed" makes the button worthless.
      fetchImpl.mockResolvedValue(
        new Response('{"error":{"message":"model not found: typo-3b"}}', { status: 404 }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: {
          kind: 'openai_compatible',
          base_url: 'http://192.168.1.50:1234/v1',
          model: 'typo-3b',
        },
      });

      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.stage).toBe('response');
      expect(body.detail).toContain('model not found: typo-3b');
    });

    it('reports a transport failure as such, not as a bad key', async () => {
      fetchImpl.mockRejectedValue(new Error('connect ECONNREFUSED 192.168.1.50:1234'));

      const res = await app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: {
          kind: 'openai_compatible',
          base_url: 'http://192.168.1.50:1234/v1',
          model: 'm',
        },
      });
      expect(res.json().stage).toBe('transport');
      expect(res.json().detail).toContain('ECONNREFUSED');
    });

    it('unwraps the cause Node hides behind "fetch failed"', async () => {
      // Found by pressing Test against a LAN host that was switched off: the
      // screen said "Could not connect. fetch failed", which is the same
      // uninformative sentence this button exists to avoid. Node's fetch
      // reports every transport failure that way and puts the real one in
      // `cause`, so a refused connection, a DNS miss and a timeout are
      // indistinguishable without unwrapping it.
      const cause = Object.assign(new Error('connect ECONNREFUSED 192.168.13.48:1234'), {
        code: 'ECONNREFUSED',
      });
      fetchImpl.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause }));

      const res = await app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: {
          kind: 'openai_compatible',
          base_url: 'http://192.168.13.48:1234/v1',
          model: 'm',
        },
      });

      const detail = res.json().detail;
      expect(detail).toContain('fetch failed');
      expect(detail).toContain('ECONNREFUSED');
      expect(detail).toContain('192.168.13.48');
    });

    it('tests a SAVED provider using the key from the vault, which the browser never has', async () => {
      const made = await create({
        name: 'Saved',
        kind: 'openai_compatible',
        base_url: 'https://openrouter.ai/api/v1',
        model: 'm',
        api_key: 'sk-vaulted-key',
        allow_public_host: true,
      });
      const id = made.json().id;

      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: { id },
      });

      expect(res.json().ok).toBe(true);
      // The decrypted key really was attached — otherwise this is a test that
      // proves only that a stub can be called.
      const sent = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> };
      expect(sent.headers.authorization).toBe('Bearer sk-vaulted-key');
    });
  });

  it('deletes only within the workspace', async () => {
    const made = await create({
      name: 'Doomed',
      kind: 'openai_compatible',
      base_url: 'http://10.0.0.5:1234/v1',
      model: 'm',
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/llm-providers/${made.json().id}`,
      headers: CSRF,
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/admin/llm-providers' })).json().items,
    ).toHaveLength(0);
  });
});

// W16-08. The half that makes W16-06/07 real: a configured provider must
// actually drive the worker's gateway. Without this the product would have a
// beautiful settings screen that changed nothing.
describeIfLiveInfra('the gateway reads configured providers (W16-08)', () => {
  const db = createDb(databaseUrl as string);
  const TOKEN = Buffer.alloc(32, 7);

  afterAll(async () => {
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WORKSPACE_ID));
    await db.$client.end();
  });

  it('turns a stored row into a callable host, with the key from the vault', async () => {
    const { hostsFromProviders } = await import('../../../workers/gateway.js');
    const { credentials } = await import('@repopulse/auth');
    const [ws] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    const enc = credentials.encryptCredential('sk-gateway-key', TOKEN);

    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, ws!.id));
    await db.insert(core.llmProviders).values([
      {
        workspaceId: ws!.id,
        name: 'Hosted',
        kind: 'openai_compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/qwen3-coder',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        allowPublicHost: true,
        createdBy: user!.id,
      },
      // A row that cannot be resolved. It must be SKIPPED WITH ITS REASON, not
      // throw — one mistyped provider taking the working ones down with it is
      // the failure this shape exists to avoid.
      {
        workspaceId: ws!.id,
        name: 'Broken',
        kind: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        allowPublicHost: false,
        createdBy: user!.id,
      },
    ]);

    const { hosts, skipped } = await hostsFromProviders(db, TOKEN, ws!.id);

    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.baseUrl).toBe('https://openrouter.ai/api/v1');
    // Decrypted and attached — otherwise the gateway would call a hosted
    // endpoint unauthenticated and get a 401 nobody could explain.
    expect(hosts[0]?.auth?.apiKey).toBe('sk-gateway-key');

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe('Broken');
    // The reason names what to fix. This row is hosted, has no key AND has not
    // opted in; the key check runs first, so that is the sentence — either way
    // the operator gets an instruction rather than "provider unavailable".
    expect(skipped[0]?.reason).toMatch(/needs an API key/i);
  });

  it("never reaches another workspace's providers — Law 5", async () => {
    // The bug this pins: the first version selected every enabled row with no
    // workspace filter, so on any install with more than one workspace (the
    // seed alone creates two) it would decrypt ONE TENANT'S API KEY and use
    // their model to analyse another tenant's diffs.
    const { hostsFromProviders } = await import('../../../workers/gateway.js');
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w16-18-other-tenant', name: 'Other tenant' })
      .onConflictDoNothing()
      .returning({ id: core.workspaces.id });
    const otherId =
      other?.id ??
      (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, 'w16-18-other-tenant'))
          .limit(1)
      )[0]!.id;

    try {
      // The other tenant has none of its own; ours are visible only to us.
      const theirs = await hostsFromProviders(db, TOKEN, otherId);
      expect(theirs.hosts).toHaveLength(0);
      expect(theirs.skipped).toHaveLength(0);
    } finally {
      await db.delete(core.workspaces).where(eq(core.workspaces.id, otherId));
    }
  });
});
