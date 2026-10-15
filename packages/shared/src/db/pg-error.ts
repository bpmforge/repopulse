// Since drizzle-orm 0.44 every failed query is rethrown as a DrizzleQueryError
// whose message is "Failed query: <sql>\nparams: <values>"; the driver's own
// error, the one carrying the SQLSTATE and the constraint name, moves to
// `cause`. Code that recognised a constraint by searching the message stopped
// matching when that happened, so a duplicate turned into a 500 instead of a
// 409. Read the fields off the driver error instead of matching text.

/** The fields of a postgres.js `PostgresError` that callers branch on. */
export interface PgErrorFields {
  /** SQLSTATE, e.g. `23505` for a unique violation. */
  code: string;
  constraint_name?: string;
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
