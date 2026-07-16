import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as core from './schema/core/index.js';
import * as facts from './schema/facts/index.js';
import * as read from './schema/read/index.js';

export * as core from './schema/core/index.js';
export * as facts from './schema/facts/index.js';
export * as read from './schema/read/index.js';

const schema = { ...core, ...facts, ...read };

// Factory, not a module-level connection — importing this file must never
// open a socket (breaks tests/typecheck that only need the schema shapes).
export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
