// Since drizzle-orm 0.44 every failed query is rethrown as a DrizzleQueryError
// whose message is "Failed query: <sql>\nparams: <values>"; the driver's own
// error, the one carrying the SQLSTATE and the constraint name, moves to
// `cause`. Code that recognised a constraint by searching the message stopped
// matching when that happened, so a duplicate turned into a 500 instead of a
// 409. Read the fields off the driver error instead of matching text.
//
// The same wrapper is also a disclosure hazard: its message, its stack and its
// enumerable `query`/`params` carry every bound value of the failed statement
// (password hashes, ciphertexts, user text). Anything that stores, logs or
// returns a caught error goes through `safeErrorText` / `redactQueryError`
// below, which keep the Postgres reason and drop the statement.

import { DrizzleQueryError } from 'drizzle-orm';

/** The fields of a postgres.js `PostgresError` that callers branch on. */
export interface PgErrorFields {
  /** SQLSTATE, e.g. `23505` for a unique violation. */
  code: string;
  constraint_name?: string;
  /** The server's own message, e.g. `duplicate key value violates…`. */
  message?: string;
}

function isPgError(value: unknown): value is PgErrorFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    // postgres.js sets `severity` on every server error; a Node system error
    // (ECONNREFUSED…) also has a string `code` and must not pass for one.
    typeof (value as { severity?: unknown }).severity === 'string'
  );
}

/**
 * The Postgres server error behind `err`, whether it was thrown bare or
 * wrapped (by drizzle, or by our own code) in one or more `cause` links.
 */
export function pgErrorOf(err: unknown): PgErrorFields | undefined {
  let current: unknown = err;
  // Bounded: a cause cycle must not hang an error handler.
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (isPgError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when `err` is a violation of the named constraint or unique index. */
export function isConstraintViolation(err: unknown, constraintName: string): boolean {
  return pgErrorOf(err)?.constraint_name === constraintName;
}

type QueryError = Error & { query: string; params: unknown[] };

/**
 * A drizzle query failure. `instanceof` first; the shape check covers a second
 * copy of drizzle-orm in the tree, whose class would not match.
 */
export function isQueryError(err: unknown): err is QueryError {
  if (err instanceof DrizzleQueryError) return true;
  return (
    err instanceof Error &&
    typeof (err as { query?: unknown }).query === 'string' &&
    Array.isArray((err as { params?: unknown }).params) &&
    err.message.startsWith('Failed query: ')
  );
}

/** Postgres reason + SQLSTATE + constraint for one query failure, never the SQL. */
/**
 * The server's message with any echoed input value taken out. Postgres quotes
 * the offending value in most data-exception messages (class 22:
 * `invalid input syntax for type integer: "…"`, `value "…" is out of range`),
 * so every quoted string goes there; elsewhere quotes name columns, relations
 * and constraints, which are worth keeping, so only a quoted bound value goes.
 */
function scrubPgMessage(message: string, code: string, params: readonly unknown[]): string {
  if (code.startsWith('22')) return message.replace(/"(?:[^"]|"")*"/g, '"[REDACTED]"');
  let out = message;
  for (const param of params) {
    if (param === null || param === undefined || typeof param === 'object') continue;
    const value = String(param);
    if (value !== '') out = out.split(`"${value}"`).join('"[REDACTED]"');
  }
  return out;
}

function queryErrorText(err: QueryError): string {
  const pg = pgErrorOf(err.cause);
  if (pg) {
    const tags = [`SQLSTATE ${pg.code}`];
    if (pg.constraint_name) tags.push(`constraint ${pg.constraint_name}`);
    const message = scrubPgMessage(pg.message ?? 'database error', pg.code, err.params);
    return `${message} (${tags.join(', ')})`;
  }
  // No server error: a dropped connection, a pool timeout. Its own text holds
  // no statement, but it may itself be wrapped, so recurse.
  return err.cause instanceof Error ? safeErrorText(err.cause) : 'database query failed';
}

/**
 * Text that is safe to store, log or return for any caught error. A drizzle
 * query failure becomes its Postgres reason with the SQLSTATE and constraint;
 * every other error keeps its own message.
 */
export function safeErrorText(err: unknown): string {
  if (isQueryError(err)) return queryErrorText(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * What a drizzle query failure turns into once it leaves the code that can
 * act on it. Carries `code`/`constraint_name`/`severity`, so `pgErrorOf` and
 * `isConstraintViolation` still recognise it, but no statement, no params and
 * no `cause` (postgres.js puts row values in a PostgresError's `detail`).
 */
export class DatabaseQueryError extends Error {
  override readonly name = 'DatabaseQueryError';
  readonly severity: string | undefined;
  readonly code: string | undefined;
  readonly constraint_name: string | undefined;

  constructor(source: QueryError) {
    super(queryErrorText(source));
    const pg = pgErrorOf(source.cause) as (PgErrorFields & { severity?: string }) | undefined;
    this.severity = pg?.severity;
    this.code = pg?.code;
    this.constraint_name = pg?.constraint_name;
    // The original stack starts with the full message (statement and params);
    // keep only its frames.
    const frames = (source.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
    this.stack = [`${this.name}: ${this.message}`, ...frames].join('\n');
  }
}

function copyError(err: Error, cause: unknown): Error {
  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error;
  for (const key of Reflect.ownKeys(err)) {
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(err, key)!);
  }
  Object.defineProperty(copy, 'cause', {
    value: cause,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

/**
 * `err` with any drizzle query failure in it (itself, or a link of its `cause`
 * chain) replaced by a `DatabaseQueryError`. Any other error is returned as
 * the same object, so class checks (BullMQ's UnrecoverableError, our typed
 * errors) still hold. A wrapped chain is copied, never mutated: the caller may
 * still be holding the original.
 */
export function redactQueryError(err: unknown, depth = 0): unknown {
  if (isQueryError(err)) return new DatabaseQueryError(err);
  if (!(err instanceof Error) || err.cause === undefined || depth >= 8) return err;
  const cause = redactQueryError(err.cause, depth + 1);
  return cause === err.cause ? err : copyError(err, cause);
}
