import { describe, expect, it } from 'vitest';
import { isConstraintViolation, pgErrorOf } from './pg-error.js';

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
