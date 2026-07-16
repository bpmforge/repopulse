import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/core/index.js';

export * as schema from './schema/core/index.js';

// Factory, not a module-level connection — importing this file must never
// open a socket (breaks tests/typecheck that only need the schema shapes).
export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
