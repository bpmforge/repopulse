import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { DrizzleQueryError } from 'drizzle-orm';
import { auditLog, createLogger, redactLine } from './index.js';

function captureLogger() {
  let output = '';
  const dest = new Writable({
    write(chunk, _enc, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = pino(
    { hooks: { streamWrite: (s: string) => redactLine(s) } },
    dest as unknown as pino.DestinationStream,
  );
  return { logger, lines: () => output };
}

describe('createLogger', () => {
  it('produces a working pino logger', () => {
    const logger = createLogger({ name: 'test' });
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.child).toBe('function');
  });
});

describe('auditLog + redaction wired together', () => {
  it('never lets a token survive in the emitted line', () => {
    const { logger, lines } = captureLogger();
    const leakedToken = 'ghp_' + 'b'.repeat(36);
    auditLog(logger, {
      event: 'auth.login.failure',
      actorUserId: null,
      workspaceId: null,
      ip: '203.0.113.7',
      ua: 'test-agent',
      // A well-behaved caller never puts a token in a free-text field, but
      // the bare-pattern layer must still catch it here (the field-name
      // layer only fires on token/credential/secret/... -shaped keys).
      reason: `oauth exchange returned ${leakedToken} unexpectedly`,
    });
    const output = lines();
    expect(output).toContain('audit:auth.login.failure');
    expect(output).not.toContain(leakedToken);
    expect(output).toContain('[REDACTED-TOKEN]');
  });

  it('carries actor/workspace/ip/ua/ts on every entry', () => {
    const { logger, lines } = captureLogger();
    auditLog(logger, {
      event: 'auth.logout',
      actorUserId: 42,
      workspaceId: 1,
      ip: '203.0.113.7',
      ua: 'test-agent',
    });
    const parsed = JSON.parse(lines());
    expect(parsed).toMatchObject({
      audit: true,
      event: 'auth.logout',
      actorUserId: 42,
      workspaceId: 1,
      ip: '203.0.113.7',
      ua: 'test-agent',
    });
    expect(typeof parsed.ts).toBe('string');
  });
});

// W16-18. LOG_LEVEL was in deploy/.env and docs/CONFIG.md and was read NOWHERE
// in source — a documented knob that did nothing, so an operator turning it up
// to debug a production incident got exactly the same output as before. A
// config option that silently does nothing costs someone the time they spent
// trusting it.
describe('LOG_LEVEL (W16-18)', () => {
  it('is read from the environment', () => {
    expect(createLogger({ env: { LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv }).level).toBe('debug');
  });

  it('is overridden by an explicit level, so a caller stays in control', () => {
    expect(
      createLogger({ level: 'warn', env: { LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv }).level,
    ).toBe('warn');
  });

  it("falls back to pino's default when nothing sets it", () => {
    expect(createLogger({ env: {} as NodeJS.ProcessEnv }).level).toBe('info');
  });
});

describe('drizzle query failures in log lines (SC-19 drizzle 0.45)', () => {
  const SENTINEL = 'argon2id$SENTINEL-51b0e2';
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    severity: 'ERROR',
    code: '23505',
    constraint_name: 'users_email_key',
    detail: `Key (password_hash)=(${SENTINEL}) already exists.`,
  });
  const failure = () =>
    new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      ['someone@example.test', SENTINEL],
      pgError,
    );

  function capture() {
    let output = '';
    const destination = new Writable({
      write(chunk, _enc, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ destination: destination as unknown as pino.DestinationStream });
    return { logger, lines: () => output };
  }

  it('never prints the bound values, however the error is handed over', () => {
    const { logger, lines } = capture();
    logger.error({ err: failure() }, 'as err');
    logger.error(failure());
    logger.error({ error: failure() }, 'under another key');
    logger.child({ requestId: 'r1' }).warn({ err: new Error('wrapper', { cause: failure() }) });
    logger.error(`interpolated: ${failure().message}`);

    const out = lines();
    expect(out.trim().split('\n')).toHaveLength(5);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain('someone@example.test');
    // The reason survives, so the line is still worth reading.
    expect(out).toContain('SQLSTATE 23505, constraint users_email_key');
  });

  it('scrubs the query text even when it reaches the line as a plain string', () => {
    const line = JSON.stringify({ msg: `boom ${failure().message}`, stack: 'x' });
    const scrubbed = redactLine(line);
    expect(scrubbed).not.toContain(SENTINEL);
    expect(scrubbed).toContain('Failed query: [REDACTED-SQL]');
  });
});
