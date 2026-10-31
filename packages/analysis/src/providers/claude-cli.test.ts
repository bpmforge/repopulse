import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../t2/client.js';
import { createEgressAuditor } from '../gateway/egress-auditor.js';
import { createAnalysisGateway } from '../gateway/index.js';
import type { CompleteOpts } from '../gateway/types.js';
import { claudeCliStatus, childEnv, cliArgs, runClaudeCli } from './claude-cli.js';
import {
  PROVIDER_REGISTRY,
  resolveProvider,
  ProviderConfigError,
  type ProviderConfig,
} from './registry.js';
import { localOnlyViolations } from '../routing/index.js';

// W19-08. The customer-supplied Claude Code CLI as a backend. What matters: it
// is constrained (no tools, nothing persisted, stdin not argv, a minimal
// environment), it fails closed in words an operator can act on, it carries no
// credential, and the gateway treats it as what it is - something that leaves
// the network, is audited, and is refused by local-only.

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: NodeJS.ErrnoException;
  hang?: boolean;
}

function fakeSpawn(script: Script | ((args: string[]) => Script)) {
  const calls: {
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    cwdExisted: boolean;
  }[] = [];
  const impl = ((bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const s = typeof script === 'function' ? script(args) : script;
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const call = {
      bin,
      args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: '',
      cwdExisted: existsSync(opts.cwd),
    };
    calls.push(call);
    stdin.on('data', (d: Buffer) => (call.stdin += d.toString()));
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = vi.fn(() => {
      child.emit('close', null);
      return true;
    });
    if (!s.hang) {
      setImmediate(() => {
        if (s.error) {
          child.emit('error', s.error);
          return;
        }
        if (s.stdout) stdout.write(s.stdout);
        if (s.stderr) stderr.write(s.stderr);
        stdout.end();
        stderr.end();
        child.emit('close', s.code ?? 0);
      });
    }
    return child;
  }) as never;
  return { impl, calls };
}

const ok = (result: string, usage: Record<string, number> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
    modelUsage: { 'claude-sonnet-x': {} },
  });

describe('runClaudeCli', () => {
  it("returns the CLI's answer, counting cached input as input", async () => {
    const f = fakeSpawn({
      stdout: ok('{"findings":[]}', {
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      }),
    });
    const r = await runClaudeCli('review this', 'sonnet', { spawnImpl: f.impl });
    expect(r).toMatchObject({
      text: '{"findings":[]}',
      model: 'claude-sonnet-x',
      tokensIn: 130,
      tokensOut: 5,
    });
  });

  it('is constrained: no tools, nothing persisted, the prompt on stdin not argv, an empty throwaway directory', async () => {
    const f = fakeSpawn({ stdout: ok('x') });
    await runClaudeCli('SECRET SOURCE CODE', 'sonnet', { spawnImpl: f.impl });
    const c = f.calls[0]!;
    expect(c.args).toEqual(cliArgs('sonnet'));
    expect(c.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--no-session-persistence',
        '--model',
        'sonnet',
      ]),
    );
    expect(c.args.join(' ')).not.toContain('SECRET SOURCE CODE'); // never in argv
    expect(c.stdin).toBe('SECRET SOURCE CODE');
    expect(c.cwdExisted).toBe(true);
    expect(existsSync(c.cwd)).toBe(false); // removed afterwards
    expect(c.args).not.toContain('--bare'); // bare mode would drop the subscription login
  });

  it("hands the child only an allow-listed environment: none of RepoPulse's secrets", () => {
    const env = childEnv({
      PATH: '/usr/bin',
      HOME: '/home/app',
      HTTPS_PROXY: 'http://p:3128',
      DATABASE_URL: 'postgres://u:p@h/db',
      TOKEN_ENC_KEY: 'abc',
      SESSION_SECRET: 's',
      ANTHROPIC_API_KEY: 'sk-ant-xyz',
      REDIS_URL: 'redis://x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/app', HTTPS_PROXY: 'http://p:3128' });
  });

  it('says the CLI is missing, and that it is customer-supplied, when the binary is not there', async () => {
    const f = fakeSpawn({
      error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    });
    const err = await runClaudeCli('p', 'sonnet', { spawnImpl: f.impl }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(
      /was not found.*customer-supplied.*install it in this container and sign in.*Nothing was sent/s,
    );
  });

  it("says signed out, using the CLI's real expired-session message", async () => {
    // Observed from a real `claude -p` on 2026-10-18, exit code 1.
    const real = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const f = fakeSpawn({ stdout: real, code: 1 });
    const err = await runClaudeCli('p', 'sonnet', { spawnImpl: f.impl }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(
      /signed out or its login expired.*OAuth session expired.*Sign in again inside this container.*Nothing was processed/s,
    );
  });

  it('reports any other CLI error with its own words, and an unusable exit without JSON', async () => {
    const e1 = await runClaudeCli('p', 'm', {
      spawnImpl: fakeSpawn({
        stdout: JSON.stringify({ is_error: true, result: 'Model "zzz" not found' }),
        code: 1,
      }).impl,
    }).catch((e) => e);
    expect(e1.message).toMatch(/reported an error: Model "zzz" not found/);
    const e2 = await runClaudeCli('p', 'm', {
      spawnImpl: fakeSpawn({ stdout: 'garbage', stderr: 'segfault', code: 139 }).impl,
    }).catch((e) => e);
    expect(e2.message).toMatch(/exited 139 without a usable answer: segfault/);
  });

  it('stops a hung CLI and says how long it waited', async () => {
    const f = fakeSpawn({ hang: true });
    const err = await runClaudeCli('p', 'm', { spawnImpl: f.impl, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(
      /did not answer within 0s and was stopped|did not answer within \d+s/,
    );
  });
});

describe('claudeCliStatus', () => {
  it("reports presence, version and only the CLI's loggedIn boolean - never the account", async () => {
    const f = fakeSpawn((args) =>
      args[0] === '--version'
        ? { stdout: '2.1.287 (Claude Code)\n' }
        : {
            stdout: JSON.stringify({
              loggedIn: true,
              email: 'someone@example.com',
              orgName: 'Acme',
              subscriptionType: 'max',
            }),
          },
    );
    const s = await claudeCliStatus({ spawnImpl: f.impl });
    expect(s).toEqual({
      found: true,
      version: '2.1.287 (Claude Code)',
      reportsLoggedIn: true,
      reason: null,
    });
    expect(JSON.stringify(s)).not.toMatch(/example\.com|Acme|max/);
  });

  it('says not found when the binary is absent', async () => {
    const f = fakeSpawn({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    const s = await claudeCliStatus({ spawnImpl: f.impl });
    expect(s).toMatchObject({ found: false, reportsLoggedIn: null });
    expect(s.reason).toMatch(/customer-supplied/);
  });
});

describe('the provider kind', () => {
  const cfg = (o: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: 5,
    name: 'My Claude',
    kind: 'claude_cli',
    baseUrl: null,
    model: 'sonnet',
    allowPublicHost: false,
    ...o,
  });

  it('is registered as customer-supplied and acceptance-gated, never as a RepoPulse feature', () => {
    expect(PROVIDER_REGISTRY.claude_cli).toMatchObject({
      customerSupplied: true,
      requiresAcceptance: true,
      supported: true,
      authClass: 'local_cli',
    });
    expect(PROVIDER_REGISTRY.claude_cli.label).toMatch(/customer-supplied/);
  });

  it('is OFF by default: it will not resolve without the recorded acceptance', () => {
    expect(() => resolveProvider(cfg())).toThrow(ProviderConfigError);
    expect(() => resolveProvider(cfg({ cliAccepted: false }))).toThrow(
      /an admin must read and accept the responsibility statement/,
    );
    expect(resolveProvider(cfg({ cliAccepted: true }))).toMatchObject({
      transport: 'claude_cli',
      modelSlot: 'sonnet',
      providerId: 5,
    });
  });

  it('holds no credential: an API key is refused, with the supported route named', () => {
    expect(() => resolveProvider(cfg({ cliAccepted: true, apiKey: 'sk-ant-x' }))).toThrow(
      /takes no API key.*Anthropic API-key provider/s,
    );
  });

  it('counts as leaving the network, so local-only refuses it naming role and connection', () => {
    const host = resolveProvider(cfg({ cliAccepted: true }));
    expect(
      localOnlyViolations({
        localOnly: true,
        chains: { patch: [{ host, providerName: 'My Claude' }] },
      }),
    ).toEqual([
      'Local-only is on: role "patch" would send to connection "My Claude", which is outside your network.',
    ]);
  });
});

describe('through the analysis gateway', () => {
  const meta = {
    repoId: '1',
    prNumber: 1,
    dimension: 'security' as const,
    checklistVersion: 'v1',
    initiator: 't',
  };
  const opts: CompleteOpts = { tier: 'T2', maxTokens: 1000, expectJson: true, meta };
  const host = resolveProvider({
    id: 5,
    name: 'My Claude',
    kind: 'claude_cli',
    baseUrl: null,
    model: 'sonnet',
    allowPublicHost: false,
    cliAccepted: true,
  });

  it('is audited as an egress to Anthropic, attempt and outcome', async () => {
    const rows: { destinationHost: string; outcome: string; modelId: string }[] = [];
    const f = fakeSpawn({ stdout: ok('{"findings":[]}') });
    const gw = createAnalysisGateway({
      hosts: [host],
      cli: { spawnImpl: f.impl },
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r as never) }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    const r = await gw.complete('p', opts);
    expect(r.text).toBe('{"findings":[]}');
    expect(r.costUsd).toBeNull();
    expect(rows.map((x) => x.outcome)).toEqual(['attempted', 'succeeded']);
    expect(rows[0]).toMatchObject({ destinationHost: 'api.anthropic.com', modelId: 'sonnet' });
  });

  it('REFUSES to run when the deployment cannot record the egress (fail closed)', async () => {
    const f = fakeSpawn({ stdout: ok('x') });
    const gw = createAnalysisGateway({ hosts: [host], cli: { spawnImpl: f.impl } });
    await expect(gw.complete('p', opts)).rejects.toThrow(/un-auditable egress/);
    expect(f.calls).toHaveLength(0);
  });

  it('is refused by the local-only switch before anything runs', async () => {
    const f = fakeSpawn({ stdout: ok('x') });
    const gw = createAnalysisGateway({
      hosts: [host],
      cli: { spawnImpl: f.impl },
      routing: { localOnly: true, chains: { security: [{ host, providerName: 'My Claude' }] } },
    });
    await expect(gw.complete('p', opts)).rejects.toThrow(
      /Local-only is on: role "security" would send to connection "My Claude"/,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('a CLI failure is a provider error, so the chain falls back past it', async () => {
    const f = fakeSpawn({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    const lan = {
      baseUrl: 'http://10.0.0.5:1234/v1',
      modelSlot: 'lan-m',
      providerId: 6,
      name: 'LAN',
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'lan-m',
            choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const gw = createAnalysisGateway({
      hosts: [host, lan],
      cli: { spawnImpl: f.impl },
      fetchImpl,
      sleep: async () => {},
      routing: {
        localOnly: false,
        chains: {
          security: [
            { host, providerName: 'My Claude' },
            { host: lan, providerName: 'LAN' },
          ],
        },
      },
      egressAuditor: createEgressAuditor({ write: async () => undefined }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    const r = await gw.complete('p', opts);
    expect(r.route).toMatchObject({ providerName: 'LAN', linkIndex: 1 });
    expect(r.route?.failedLinks[0]?.error).toMatch(/was not found/);
  });
});

// W23-06. The static half of the prompt rides the system flag, the diff stays
// on stdin, and cache-read tokens are reported separately from tokensIn.
describe('runClaudeCli static/dynamic split (W23-06)', () => {
  const parts = { static: 'CHECKLIST + SCHEMA', dynamic: 'PR + SECRET DIFF' };
  const prompt = `${parts.static}\n\n${parts.dynamic}`;

  it('sends static via --append-system-prompt and only the dynamic part on stdin', async () => {
    const f = fakeSpawn({ stdout: ok('x') });
    await runClaudeCli(prompt, 'sonnet', { spawnImpl: f.impl }, parts);
    const c = f.calls[0]!;
    expect(c.args).toEqual(cliArgs('sonnet', parts.static));
    const i = c.args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(c.args[i + 1]).toBe(parts.static);
    expect(c.stdin).toBe(parts.dynamic);
    expect(c.args.join(' ')).not.toContain('SECRET DIFF');
  });

  it('falls back to the whole prompt on stdin when the parts do not reassemble to it', async () => {
    const f = fakeSpawn({ stdout: ok('x') });
    await runClaudeCli(`${prompt}\n\nretry note`, 'sonnet', { spawnImpl: f.impl }, parts);
    const c = f.calls[0]!;
    expect(c.args).toEqual(cliArgs('sonnet'));
    expect(c.stdin).toContain('retry note');
  });

  it('reports cache_read_input_tokens as cacheReadTokens, and 0 when absent', async () => {
    const withCache = fakeSpawn({
      stdout: ok('x', { cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    });
    expect(await runClaudeCli('p', 'sonnet', { spawnImpl: withCache.impl })).toMatchObject({
      tokensIn: 130,
      cacheReadTokens: 100,
    });
    const without = fakeSpawn({ stdout: ok('x') });
    expect(await runClaudeCli('p', 'sonnet', { spawnImpl: without.impl })).toMatchObject({
      tokensIn: 10,
      cacheReadTokens: 0,
    });
  });
});
