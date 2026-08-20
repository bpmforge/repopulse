import { describe, expect, it } from 'vitest';
import { ENV_REGISTRY, formatEnvProblems, validateEnv } from './env-registry.js';

// Startup configuration checks (W11-02, acceptance 4).

const complete = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/repopulse',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(40),
  TOKEN_ENC_KEY: 'a'.repeat(64),
  API_BASE_URL: 'https://api.example.com',
  PUBLIC_BASE_URL: 'https://repopulse.example.com',
  GITHUB_APP_CLIENT_ID: 'Iv1.abc123',
  GITHUB_APP_CLIENT_SECRET: 'secret',
} as NodeJS.ProcessEnv;

describe('validating the environment', () => {
  it('passes a complete configuration', () => {
    expect(validateEnv(complete)).toEqual([]);
  });

  it('reports EVERY problem at once, not one restart at a time', () => {
    const problems = validateEnv({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv);
    expect(problems.length).toBeGreaterThan(3);
    expect(problems.map((p) => p.name)).toContain('SESSION_SECRET');
    expect(problems.map((p) => p.name)).toContain('TOKEN_ENC_KEY');
  });

  it('names the variable and says what it is for', () => {
    const [problem] = validateEnv({ ...complete, DATABASE_URL: undefined });
    expect(problem!.name).toBe('DATABASE_URL');
    expect(problem!.reason).toContain('Postgres');
  });

  it('rejects a TOKEN_ENC_KEY that is not 32 bytes of hex, with the fix in the message', () => {
    const [problem] = validateEnv({ ...complete, TOKEN_ENC_KEY: 'too-short' });
    expect(problem!.reason).toContain('openssl rand -hex 32');
  });

  it('catches a URL typed without a scheme', () => {
    const [problem] = validateEnv({ ...complete, PUBLIC_BASE_URL: 'repopulse.example.com' });
    expect(problem!.name).toBe('PUBLIC_BASE_URL');
  });

  it('treats an EMPTY value as missing, not as set', () => {
    // `FOO=` in a .env file is the classic half-filled case.
    const problems = validateEnv({ ...complete, SESSION_SECRET: '' });
    expect(problems.map((p) => p.name)).toContain('SESSION_SECRET');
  });

  it("accepts 'off' for a cron variable, and rejects nonsense", () => {
    // Cron variables are WORKER scope, so the scopes have to say so — which is
    // itself the behaviour the next test pins down.
    const scopes = ['api', 'shared', 'worker'] as const;
    expect(validateEnv({ ...complete, RECONCILE_CRON: 'off' }, scopes)).toEqual([]);
    expect(validateEnv({ ...complete, RECONCILE_CRON: 'nightly' }, scopes)[0]?.name).toBe(
      'RECONCILE_CRON',
    );
  });

  it('does not require worker-only variables of the API', () => {
    expect(validateEnv(complete, ['api', 'shared'])).toEqual([]);
  });

  it('formats a message an operator can act on without reading a stack trace', () => {
    const message = formatEnvProblems(validateEnv({} as NodeJS.ProcessEnv));
    expect(message).toContain('RepoPulse cannot start');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('docs/CONFIG.md');
    expect(message).not.toContain('at Object.');
  });

  it('marks every credential as secret', () => {
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'TOKEN_ENC_KEY', 'GITHUB_APP_CLIENT_SECRET']) {
      expect(ENV_REGISTRY.find((e) => e.name === name)?.secret, name).toBe(true);
    }
  });
});
