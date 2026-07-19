import 'dotenv/config';
import { createDb, seedWarehouse } from '@repopulse/shared';

// Seeds the compose dev warehouse deterministically before the e2e run so every
// suite (W4/W5/W6) shares the same fixture data (docs/TESTING.md §6). No-ops
// when DATABASE_URL is absent so `pnpm exec playwright test --list` still works.
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const db = createDb(url);
  await seedWarehouse(db);
  await db.$client.end();
}
