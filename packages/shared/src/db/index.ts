import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as core from './schema/core/index.js';
import * as facts from './schema/facts/index.js';
import * as read from './schema/read/index.js';
import * as plans from './schema/plans/index.js';
import * as security from './schema/security/index.js';

export * as core from './schema/core/index.js';
export * as facts from './schema/facts/index.js';
export * as read from './schema/read/index.js';
export * as plans from './schema/plans/index.js';
export * as security from './schema/security/index.js';

const schema = { ...core, ...facts, ...read, ...plans, ...security };

// Factory, not a module-level connection — importing this file must never
// open a socket (breaks tests/typecheck that only need the schema shapes).
export interface CreateDbOptions {
  /**
   * Handler for Postgres NOTICE messages.
   *
   * Defaulted to a no-op for the MIGRATOR's sake (W13-06): postgres.js prints
   * every notice as a multi-line object, so a clean install printed
   * `severity: 'NOTICE', message: 'relation "__drizzle_migrations" already
   * exists, skipping'` in a shape indistinguishable from an error — and the
   * install guide tells an operator to read that output. Pass a handler to see
   * them.
   */
  onnotice?: (notice: unknown) => void;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  const client = postgres(databaseUrl, {
    onnotice: options.onnotice ?? (() => {}),
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
