import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import {
  DatabaseQueryError,
  isConstraintViolation,
  pgErrorOf,
  redactQueryError,
  safeErrorText,
} from './pg-error.js';

// Shaped like a postgres.js PostgresError: these are the fields it sets.
const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), {
  severity: 'ERROR',
  code: '23505',
  constraint_name: 'llm_providers_workspace_name_key',
});

describe('pgErrorOf', () => {
  it('finds the driver error under a drizzle DrizzleQueryError-style wrapper', () => {
    const wrapped = new Error('Failed query: insert into ...\nparams: x', {
      cause: uniqueViolation,
    });
    expect(pgErrorOf(wrapped)).toBe(uniqueViolation);
    expect(isConstraintViolation(wrapped, 'llm_providers_workspace_name_key')).toBe(true);
  });

  it('accepts a bare driver error', () => {
    expect(pgErrorOf(uniqueViolation)?.code).toBe('23505');
  });

  it('does not mistake a Node system error for a Postgres one', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(pgErrorOf(new Error('Failed query', { cause: refused }))).toBeUndefined();
  });

  it('matches only the named constraint', () => {
    expect(isConstraintViolation(uniqueViolation, 'some_other_key')).toBe(false);
    expect(
      isConstraintViolation(
        new Error('llm_providers_workspace_name_key'),
        'llm_providers_workspace_name_key',
      ),
    ).toBe(false);
  });

  it('stops on a cause cycle', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(pgErrorOf(a)).toBeUndefined();
  });
});

// A bound value nobody should ever read back out of an error.
const SENTINEL = 'argon2id$SENTINEL-7f3a9c';

function failedInsert(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "users" ("email", "password_hash") values ($1, $2)',
    ['someone@example.test', SENTINEL],
    uniqueViolation,
  );
}

/** Every string an error exposes to a serializer: message, stack, own props. */
function everythingIn(err: unknown): string {
  const seen: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 8 && current instanceof Error; i++) {
    seen.push(current.message, current.stack ?? '', JSON.stringify(current));
    for (const key of Reflect.ownKeys(current)) {
      seen.push(String((current as unknown as Record<PropertyKey, unknown>)[key]));
    }
    current = current.cause;
  }
  return seen.join('\n');
}

describe('safeErrorText', () => {
  it('gives the Postgres reason, SQLSTATE and constraint, never the statement or params', () => {
    const text = safeErrorText(failedInsert());
    expect(text).toBe(
      'duplicate key value violates unique constraint (SQLSTATE 23505, constraint llm_providers_workspace_name_key)',
    );
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('insert into');
  });

  it('takes an echoed value out of the Postgres message itself', () => {
    const outOfRange = Object.assign(
      new Error(`value "${SENTINEL}" is out of range for type integer`),
      {
        severity: 'ERROR',
        code: '22003',
      },
    );
    expect(safeErrorText(new DrizzleQueryError('select $1', [SENTINEL], outOfRange))).toBe(
      'value "[REDACTED]" is out of range for type integer (SQLSTATE 22003)',
    );
    // Outside class 22 only a quoted bound value goes; identifiers stay.
    const fk = Object.assign(
      new Error(
        `insert on table "repos" violates foreign key constraint "repos_fk" for "${SENTINEL}"`,
      ),
      { severity: 'ERROR', code: '23503', constraint_name: 'repos_fk' },
    );
    expect(safeErrorText(new DrizzleQueryError('insert …', [SENTINEL], fk))).toBe(
      'insert on table "repos" violates foreign key constraint "repos_fk" for "[REDACTED]" (SQLSTATE 23503, constraint repos_fk)',
    );
  });

  it('falls back to the cause when no server error is behind the failure', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const err = new DrizzleQueryError('select $1', [SENTINEL], refused);
    expect(safeErrorText(err)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('leaves every other error its own message', () => {
    expect(safeErrorText(new Error('HTTP 502 upstream'))).toBe('HTTP 502 upstream');
    expect(safeErrorText('plain string')).toBe('plain string');
  });
});

describe('redactQueryError', () => {
  it('replaces a query failure with one that carries no statement, params or detail', () => {
    const safe = redactQueryError(failedInsert());
    expect(safe).toBeInstanceOf(DatabaseQueryError);
    expect(everythingIn(safe)).not.toContain(SENTINEL);
    expect((safe as Error).stack).toMatch(/^DatabaseQueryError: duplicate key value/);
    // Still recognisable to the code that branches on constraints.
    expect(isConstraintViolation(safe, 'llm_providers_workspace_name_key')).toBe(true);
  });

  it('copies a chain that wraps one, leaving the original untouched', () => {
    const inner = failedInsert();
    const outer = new TypeError('sync step failed', { cause: inner });
    const safe = redactQueryError(outer) as Error;
    expect(safe).not.toBe(outer);
    expect(safe).toBeInstanceOf(TypeError);
    expect(safe.message).toBe('sync step failed');
    expect(everythingIn(safe)).not.toContain(SENTINEL);
    expect(outer.cause).toBe(inner);
  });

  it('returns any other error as the same object', () => {
    const plain = new Error('boom', { cause: new Error('root') });
    expect(redactQueryError(plain)).toBe(plain);
  });
});
