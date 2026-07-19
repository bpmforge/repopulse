import 'dotenv/config';
import { createDb } from '../../db/index.js';
import { seedWarehouse } from './seed.js';

// CLI runner for `pnpm seed` — populates the compose dev warehouse
// deterministically so the web app and the Playwright e2e suites have data.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed');
  const db = createDb(url);
  const result = await seedWarehouse(db);
  console.log(`seeded warehouse: ${JSON.stringify(result.counts)}`);
  await db.$client.end();
}

main().catch((err: unknown) => {
  console.error('seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
