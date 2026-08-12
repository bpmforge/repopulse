import 'dotenv/config';
import { createDb, seedWarehouse } from '@repopulse/shared';

// Seeds the compose dev warehouse deterministically before the e2e run so every
// suite (W4/W5/W6) shares the same fixture data (docs/TESTING.md §6).
//
// Fails loudly on a missing DATABASE_URL rather than returning early. The
// earlier no-op existed to keep `playwright test --list` working, but --list
// does not execute globalSetup at all, so it bought nothing and cost a great
// deal: with no .env the whole suite ran green against an unseeded warehouse —
// a setup that could not fail, which is precisely how this harness was
// mistakenly recorded as verified in the first place.
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'e2e globalSetup: DATABASE_URL is not set — refusing to run against an unseeded warehouse. ' +
        'Start the dev stack (podman compose -f compose.dev.yaml up -d postgres redis) and ensure .env is present.',
    );
  }
  const db = createDb(url);
  await seedWarehouse(db);
  await db.$client.end();
}
