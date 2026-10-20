import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_REGISTRY } from '../../src/routes/setup/env-registry.js';

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const configureMjs = path.join(repoRoot, 'deploy/configure.mjs');

/**
 * deploy/configure.mjs (W17-05).
 *
 * The script is deliberately self-contained — it runs inside the migrate image
 * on a customer host with no Node and no workspace on disk, so it cannot import
 * ENV_REGISTRY. The first test is the gate that keeps that duplication honest.
 */
describe('deploy/configure.mjs (W17-05)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rp cfg-'));
    // The real example, so the generated file is exercised against the file
    // customers actually get.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.env.example'),
      readFileSync(path.join(repoRoot, 'deploy/.env.example'), 'utf8'),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function configure(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run('node', [configureMjs, ...args], {
        env: { ...process.env, REPOPULSE_DEPLOY_DIR: dir, ADMIN_PASSWORD: '', ...env },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  const readEnv = (): Record<string, string> =>
    Object.fromEntries(
      readFileSync(path.join(dir, '.env'), 'utf8')
        .split('\n')
        .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => [m[1], m[2]]),
    );

  it('its duplicated REQUIRED list still matches ENV_REGISTRY', () => {
    // configure.mjs cannot import the registry (it runs with only /deploy
    // mounted), so the list is copied. This is the gate that fails when the
    // registry gains a required variable and the copy does not.
    const source = readFileSync(configureMjs, 'utf8');
    const block = /const REQUIRED = \[([^\]]+)\]/.exec(source);
    expect(block, 'configure.mjs no longer declares REQUIRED = [...]').toBeTruthy();

    const copied = [...(block?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]).sort();

    // The registry's required variables that a config file can actually supply.
    // 'web' scope is baked into the built assets, not read from .env at runtime.
    const registryRequired = ENV_REGISTRY.filter((v) => v.required && v.scope !== 'web')
      .map((v) => v.name)
      .sort();

    expect(copied).toEqual(registryRequired);
  });

  it('writes a complete .env from a clean start', async () => {
    const { code, out } = await configure(['--url=https://repopulse.example.com', '--no-admin']);

    expect(code).toBe(0);
    expect(out).toContain('Wrote deploy/.env');

    const env = readEnv();
    expect(env.PUBLIC_BASE_URL).toBe('https://repopulse.example.com');
    expect(env.API_BASE_URL).toBe('https://repopulse.example.com');
    // 32 bytes of hex, because loadTokenKey validates the length at boot.
    expect(env.TOKEN_ENC_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.SCAN_RUNNER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // W20-17: nothing reads a global webhook secret (they are per connection).
    expect(env.WEBHOOK_SECRET).toBeUndefined();
    // The connection URLs must carry the passwords that were just generated —
    // the hand-edit step this script exists to remove.
    expect(env.DATABASE_URL).toContain(env.POSTGRES_PASSWORD);
    expect(env.REDIS_URL).toContain(env.REDIS_PASSWORD);
    expect(env.POSTGRES_PASSWORD).not.toBe('');
  });

  it('writes it 0600, because it holds every secret the deployment has', async () => {
    await configure(['--url=https://repopulse.example.com', '--no-admin']);
    const mode = statSync(path.join(dir, '.env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves the example comments so the file stays editable', async () => {
    await configure(['--url=https://repopulse.example.com', '--no-admin']);
    const text = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(text).toContain('# --- the first administrator (D14) ---');
    expect(text).toContain('decrypts stored forge credentials');
  });

  it('rerunning preserves every secret BYTE FOR BYTE', async () => {
    // Rotating TOKEN_ENC_KEY silently orphans every stored forge credential.
    await configure(['--url=https://repopulse.example.com', '--no-admin']);
    const before = readFileSync(path.join(dir, '.env'), 'utf8');

    const { code, out } = await configure([
      '--url=https://something-else.example.com',
      '--no-admin',
    ]);
    const after = readFileSync(path.join(dir, '.env'), 'utf8');

    expect(code).toBe(0);
    expect(after).toBe(before);
    expect(out).toContain('already exists');
    expect(out).toMatch(/not regenerated|leaving it exactly/);
  });

  it('never prints a generated secret', async () => {
    const { out } = await configure(['--url=https://repopulse.example.com', '--no-admin']);
    const env = readEnv();
    for (const key of [
      'TOKEN_ENC_KEY',
      'SESSION_SECRET',
      'SCAN_RUNNER_TOKEN',
      'POSTGRES_PASSWORD',
    ]) {
      expect(out, `${key} leaked into stdout`).not.toContain(env[key]);
    }
  });

  it('rejects a URL with no scheme', async () => {
    const { code, out } = await configure(['--url=repopulse.example.com']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/must be a valid absolute URL/);
    expect(existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('rejects a non-http scheme', async () => {
    const { code, out } = await configure(['--url=ftp://repopulse.example.com']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/must be an http:\/\/ or https:\/\/ URL/);
  });

  it('requires --url at all', async () => {
    const { code, out } = await configure([]);
    expect(code).not.toBe(0);
    expect(out).toContain('--url is required');
  });

  it('rejects a port that is not a number, out of range, or privileged', async () => {
    for (const [port, pattern] of [
      ['not-a-port', /must be a number/],
      ['70000', /must be between 1 and 65535/],
      ['80', /privileged port/],
    ] as const) {
      const { code, out } = await configure([`--url=https://x.example.com`, `--port=${port}`]);
      expect(code, `port ${port} should be rejected`).not.toBe(0);
      expect(out).toMatch(pattern);
    }
  });

  // W20-07 (UX_TODO INS-02): no --admin-email wrote an install nobody could
  // sign in to, and a re-run with the flag could not fix it (.env is kept).
  it('refuses to write an install with no administrator unless told --no-admin', async () => {
    const { code, out } = await configure(['--url=https://x.example.com']);
    expect(code).not.toBe(0);
    expect(out).toContain('--admin-email is required');
    expect(out).toContain('deploy/admin-password');
    expect(existsSync(path.join(dir, '.env'))).toBe(false);

    const explicit = await configure(['--url=https://x.example.com', '--no-admin']);
    expect(explicit.code).toBe(0);
    expect(explicit.out).toContain('this install has NO administrator');
    expect(explicit.out).toContain('ADMIN_EMAIL=you@example.com');
  });

  it('refuses an admin email with no password rather than inventing one', async () => {
    // A shipped default password is the same password on every install.
    const { code, out } = await configure([
      '--url=https://x.example.com',
      '--admin-email=admin@example.com',
    ]);
    expect(code).not.toBe(0);
    expect(out).toContain('no password was supplied');
    expect(out).toContain('deploy/admin-password');
  });

  it('reads the admin password from a file, never from an argument', async () => {
    writeFileSync(path.join(dir, 'admin-password'), 'a-long-enough-password\n');
    const { code } = await configure([
      '--url=https://x.example.com',
      '--admin-email=admin@example.com',
    ]);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.ADMIN_EMAIL).toBe('admin@example.com');
    expect(env.ADMIN_PASSWORD).toBe('a-long-enough-password');
    // W20-17 (UX_TODO INS-71): and the plaintext file is gone afterwards.
    expect(existsSync(path.join(dir, 'admin-password'))).toBe(false);
  });

  it('rejects a too-short admin password', async () => {
    const { code, out } = await configure(
      ['--url=https://x.example.com', '--admin-email=admin@example.com'],
      { ADMIN_PASSWORD: 'short' },
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/too short/);
  });

  it('generates a different key on every fresh install', async () => {
    await configure(['--url=https://x.example.com', '--no-admin']);
    const first = readEnv().TOKEN_ENC_KEY;
    rmSync(path.join(dir, '.env'));
    await configure(['--url=https://x.example.com', '--no-admin']);
    expect(readEnv().TOKEN_ENC_KEY).not.toBe(first);
  });
});

describe('deploy configuration is not committable (W17-05)', () => {
  it('deploy/.env is gitignored and the example holds no real secret', () => {
    const ignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^deploy\/\.env$/m);

    const example = readFileSync(path.join(repoRoot, 'deploy/.env.example'), 'utf8');
    for (const key of ['SESSION_SECRET', 'TOKEN_ENC_KEY', 'POSTGRES_PASSWORD']) {
      const m = new RegExp(`^${key}=(.*)$`, 'm').exec(example);
      expect(m, `${key} missing from .env.example`).toBeTruthy();
      expect(m?.[1] ?? '', `${key} ships with a value`).toBe('');
    }
  });
});
