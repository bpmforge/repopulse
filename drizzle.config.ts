import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './packages/shared/src/db/schema/core/index.ts',
    './packages/shared/src/db/schema/facts/index.ts',
    './packages/shared/src/db/schema/read/index.ts',
    // W5-06. Listed explicitly: drizzle-kit reads THIS array, not the barrel in
    // db/index.ts, so a schema directory absent here generates no migration and
    // the tables simply never exist.
    './packages/shared/src/db/schema/plans/index.ts',
  ],
  out: './packages/shared/drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
});
