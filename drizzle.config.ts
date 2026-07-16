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
  ],
  out: './packages/shared/drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
});
