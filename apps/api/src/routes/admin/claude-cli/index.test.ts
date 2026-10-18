import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import {
  CLAUDE_CLI_STATEMENT_SHA256,
  CLAUDE_CLI_STATEMENT_VERSION,
  claudeCliStatementText,
} from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import claudeCliRoutes from './index.js';
import llmProviderRoutes from '../llm-providers/index.js';
import llmRoutingRoutes from '../llm-routing/index.js';
import errorEnvelopePlugin from '../../../plugins/error-envelope.js';
import { isClaudeCliAccepted } from '../../../lib/claude-cli-acceptance.js';

// W19-08. The customer-supplied Claude Code CLI option: OFF by default, turned
// on only by an admin's recorded acceptance of the exact statement, per
// workspace, revocable, and it holds no credential. These tests run the real
// routes and the real tables; only the CLI process is faked.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };
const TOKEN_KEY = Buffer.alloc(32, 7);

/** A fake child process: prints `stdout` and exits with `code`, or fails to start. */
function fakeCli(script: { stdout?: string; code?: number; enoent?: boolean }) {
  return {
    spawnImpl: ((_bin: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new PassThrough();
      child.stdout = stdout;
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        if (script.enoent) {
          child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
          return;
        }
        // `--version` and `auth status` answer like the real CLI; only the call
        // that carries the prompt follows the script.
        const probing = args[0] === '--version' || args[0] === 'auth';
        stdout.end(
          args[0] === '--version'
            ? '2.1.287 (Claude Code)\n'
            : args[0] === 'auth'
              ? '{"loggedIn":true}'
              : (script.stdout ?? ''),
        );
        (child.stderr as PassThrough).end();
        child.emit('close', probing ? 0 : (script.code ?? 0));
      });
      return child;
    }) as never,
  };
}
let cliScript: Parameters<typeof fakeCli>[0] = { stdout: '' };

describeIfLiveInfra('the customer-supplied Claude Code CLI option (W19-08)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  const logs: string[] = [];
  let WS = 1;
  let OTHER = 0;
  let asWorkspace = 1;
  let USER = 0;

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, w));
      await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, w));
      await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, w));
      await db
        .delete(core.llmResponsibilityAcceptances)
        .where(eq(core.llmResponsibilityAcceptances.workspaceId, w));
    }
  }

  beforeAll(async () => {
    const [ws] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    if (!ws || !user) throw new Error('seed the warehouse first: pnpm seed');
    WS = ws.id;
    USER = user.id;
    asWorkspace = ws.id;
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-08-other', name: 'Other' })
      .onConflictDoNothing();
    const [o] = await db
      .select({ id: core.workspaces.id })
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, 'w19-08-other'))
      .limit(1);
    OTHER = o!.id;

    app = Fastify({
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } },
    });
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: asWorkspace, slug: 'test', name: 'test' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k) => (k === 'userId' ? user.id : undefined),
      };
    });
    const cli = {
      get spawnImpl() {
        return fakeCli(cliScript).spawnImpl;
      },
    } as never;
    await app.register(claudeCliRoutes, { db, cli });
    await app.register(llmProviderRoutes, { db, tokenKey: TOKEN_KEY, cli });
    await app.register(llmRoutingRoutes, { db });
    await app.ready();
  });
  afterAll(async () => {
    await clear();
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER));
    await app.close();
    await db.$client.end();
  });
  beforeEach(async () => {
    await clear();
    logs.length = 0;
    asWorkspace = WS;
    cliScript = { stdout: '' };
  });

  const get = () => app.inject({ method: 'GET', url: '/admin/llm-providers/claude-cli' });
  const accept = (over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/admin/llm-providers/claude-cli/accept',
      headers: CSRF,
      payload: {
        accept: true,
        statement_version: CLAUDE_CLI_STATEMENT_VERSION,
        statement_sha256: CLAUDE_CLI_STATEMENT_SHA256,
        ...over,
      },
    });
  const create = (over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/admin/llm-providers',
      headers: CSRF,
      payload: { name: 'My Claude', kind: 'claude_cli', model: 'sonnet', ...over },
    });

  it('is OFF by default: nothing accepted, and a connection cannot be created', async () => {
    const body = (await get()).json();
    expect(body.accepted).toBeNull();
    expect(await isClaudeCliAccepted(db, WS)).toBe(false);
    const res = await create();
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toMatch(/option is off/);
    expect(res.json().detail).toMatch(/accept the responsibility statement/);
  });

  it('serves the statement, and it says the things the ticket requires, plainly', async () => {
    const { statement } = (await get()).json();
    expect(statement).toMatchObject({
      version: CLAUDE_CLI_STATEMENT_VERSION,
      sha256: CLAUDE_CLI_STATEMENT_SHA256,
    });
    const text = claudeCliStatementText();
    expect(text).toMatch(/customer-supplied, not a RepoPulse feature/);
    expect(text).toMatch(/responsible for your plan's terms/);
    expect(text).toMatch(/have not verified that those terms permit it/);
    expect(text).toMatch(/does not store or transmit your login/);
    expect(text).toMatch(/API keys remain the supported route/);
    expect(text).toMatch(/"Local only" switch refuses this option/);
    expect(JSON.stringify(statement.points)).toContain('does not store or transmit your login');
  });

  it('refuses an acceptance that is not explicit, or of text other than the current statement', async () => {
    expect((await accept({ accept: false })).statusCode).toBe(400);
    const stale = await accept({ statement_sha256: 'deadbeef' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().title).toMatch(/statement has changed/);
    expect((await accept({ statement_version: 'claude-cli.v0' })).statusCode).toBe(409);
    expect(await isClaudeCliAccepted(db, WS)).toBe(false);
  });

  it('records WHO, WHEN and WHICH VERSION, writes an audit event, and then allows a connection', async () => {
    const res = await accept();
    expect(res.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(core.llmResponsibilityAcceptances)
      .where(eq(core.llmResponsibilityAcceptances.workspaceId, WS));
    expect(row).toMatchObject({
      topic: 'claude_cli',
      statementVersion: CLAUDE_CLI_STATEMENT_VERSION,
      statementSha256: CLAUDE_CLI_STATEMENT_SHA256,
      acceptedBy: USER,
      revokedAt: null,
    });
    expect(row!.acceptedAt).toBeInstanceOf(Date);
    const audit = logs
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === 'audit:llm_claude_cli.accepted');
    expect(audit).toMatchObject({
      audit: true,
      actorUserId: USER,
      workspaceId: WS,
      detail: { statement_version: CLAUDE_CLI_STATEMENT_VERSION },
    });

    const shown = (await get()).json().accepted;
    expect(shown).toMatchObject({ version: CLAUDE_CLI_STATEMENT_VERSION, current: true });
    expect(shown.by).toBeTruthy();
    expect((await accept()).statusCode).toBe(409); // already accepted
    expect((await create()).statusCode).toBe(201);
  });

  it('holds no credential: an API key is refused, nothing is encrypted or stored, and the base URL is ignored', async () => {
    await accept();
    const withKey = await create({ api_key: 'sk-ant-should-not-be-here' });
    expect(withKey.statusCode).toBe(400);
    expect(withKey.json().title).toMatch(/takes no API key/);
    expect((await create({ base_url: 'http://evil.example:9/v1' })).statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(core.llmProviders)
      .where(and(eq(core.llmProviders.workspaceId, WS), eq(core.llmProviders.kind, 'claude_cli')));
    expect(row).toMatchObject({
      baseUrl: null,
      credentialCiphertext: null,
      credentialFingerprint: null,
      headers: null,
    });
  });

  it("is per workspace: another tenant's acceptance does not turn it on here", async () => {
    asWorkspace = OTHER;
    expect((await accept()).statusCode).toBe(201);
    asWorkspace = WS;
    expect(await isClaudeCliAccepted(db, WS)).toBe(false);
    expect((await create()).statusCode).toBe(403);
  });

  it('can be revoked: the row stays as history, new connections are refused, and existing ones stop resolving with a reason', async () => {
    await accept();
    await create();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/llm-providers/claude-cli/revoke',
      headers: CSRF,
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    const [row] = await db
      .select()
      .from(core.llmResponsibilityAcceptances)
      .where(eq(core.llmResponsibilityAcceptances.workspaceId, WS));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    expect(row!.revokedBy).toBe(USER);
    expect(
      logs.map((l) => JSON.parse(l)).some((l) => l.msg === 'audit:llm_claude_cli.revoked'),
    ).toBe(true);
    expect((await create({ name: 'Another' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/llm-providers/claude-cli/revoke',
          headers: CSRF,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);

    const { hostsFromProviders } = await import('../../../workers/gateway.js');
    const r = await hostsFromProviders(db, TOKEN_KEY, WS);
    expect(r.hosts).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ name: 'My Claude' });
    expect(r.skipped[0]!.reason).toMatch(
      /an admin must read and accept the responsibility statement/,
    );
  });

  it('re-accepting after a revoke records a new row; the history keeps both', async () => {
    await accept();
    await app.inject({
      method: 'POST',
      url: '/admin/llm-providers/claude-cli/revoke',
      headers: CSRF,
      payload: {},
    });
    expect((await accept()).statusCode).toBe(201);
    const rows = await db
      .select()
      .from(core.llmResponsibilityAcceptances)
      .where(eq(core.llmResponsibilityAcceptances.workspaceId, WS));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('with the option on, the worker resolves the connection as a CLI host', async () => {
    await accept();
    await create();
    const { hostsFromProviders } = await import('../../../workers/gateway.js');
    const r = await hostsFromProviders(db, TOKEN_KEY, WS);
    expect(r.skipped).toEqual([]);
    expect(r.hosts[0]).toMatchObject({
      transport: 'claude_cli',
      modelSlot: 'sonnet',
      name: 'My Claude',
    });
  });

  describe('Test connection', () => {
    const test = () =>
      app.inject({
        method: 'POST',
        url: '/admin/llm-providers/test',
        headers: CSRF,
        payload: { kind: 'claude_cli', model: 'sonnet' },
      });

    it('says the option is off before anything runs', async () => {
      const r = (await test()).json();
      expect(r).toMatchObject({ ok: false, stage: 'config' });
      expect(r.detail).toMatch(/option is off/);
    });

    it("runs the customer's CLI once and reports the model's answer", async () => {
      await accept();
      cliScript = {
        stdout: JSON.stringify({
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 5, output_tokens: 1 },
          modelUsage: { 'claude-sonnet-x': {} },
        }),
      };
      const r = (await test()).json();
      expect(r).toMatchObject({ ok: true, model: 'claude-sonnet-x', sample: 'ok' });
    });

    it('fails closed in plain words when the CLI is missing, and when it is signed out', async () => {
      await accept();
      cliScript = { enoent: true };
      const missing = (await test()).json();
      expect(missing).toMatchObject({ ok: false, stage: 'config' });
      expect(missing.detail).toMatch(
        /was not found.*customer-supplied.*install it in this container and sign in/s,
      );

      // The CLI's real expired-session message, observed on 2026-10-18.
      cliScript = {
        stdout: JSON.stringify({
          is_error: true,
          result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        }),
        code: 1,
      };
      const signedOut = (await test()).json();
      expect(signedOut).toMatchObject({ ok: false, stage: 'transport' });
      expect(signedOut.detail).toMatch(
        /signed out or its login expired.*Sign in again inside this container/s,
      );
    });
  });

  it('local-only refuses a role routed to it, naming the role and the connection', async () => {
    await accept();
    const created = await create();
    const id = created.json().id;
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/llm-routing',
      headers: CSRF,
      payload: { local_only: true, roles: { patch: [{ provider_id: id }] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe(
      'Local-only is on: role "patch" would send to connection "My Claude", which is outside your network.',
    );
    // And the screen is told it leaves, with Anthropic as the host.
    const routing = (await app.inject({ method: 'GET', url: '/admin/llm-routing' })).json();
    expect(routing.providers.find((p: { name: string }) => p.name === 'My Claude')).toMatchObject({
      host: 'api.anthropic.com',
      leaves_network: true,
    });
  });

  it('is listed as customer-supplied and acceptance-gated in the kinds catalogue, never as a plain feature', async () => {
    const kinds = (await app.inject({ method: 'GET', url: '/admin/llm-providers/kinds' })).json()
      .kinds;
    const k = kinds.find((x: { kind: string }) => x.kind === 'claude_cli');
    expect(k).toMatchObject({
      supported: true,
      customer_supplied: true,
      requires_acceptance: true,
      needs_base_url: false,
    });
    expect(k.label).toMatch(/customer-supplied/);
    expect(kinds.filter((x: { customer_supplied: boolean }) => x.customer_supplied)).toHaveLength(
      1,
    );
  });
});
