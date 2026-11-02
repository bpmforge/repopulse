import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { createRedisConnection } from '@repopulse/ingest';
import { eq } from 'drizzle-orm';
import { core, createDb, FAKE_TOKEN, seedWarehouse } from '@repopulse/shared';
// By path, as e2e/server.ts imports apps/api: the root package does not depend
// on @repopulse/auth, and only the vault can seal a credential.
import { credentials } from '../packages/auth/src/index.js';
import { PORTS } from '../ports.config.mjs';

export const STORAGE_STATE = 'e2e/.auth/state.json';

// Seeds the compose dev warehouse deterministically before the e2e run so every
// suite (W4/W5/W6) shares the same fixture data (docs/TESTING.md §6), then logs
// in ONCE and saves the session for every spec to reuse.
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
  await sealSeededConnection(db);
  await db.$client.end();

  // Drop every BullMQ key before the run. The seeder recreates repo rows with
  // fresh ids, but jobs keyed by the PREVIOUS run's ids survive in Redis, and
  // BullMQ treats an add with an existing custom jobId as a no-op — so a run
  // could inherit a completed job from an earlier run and report success while
  // ingesting nothing. Leftover `delayed` retries from a failed run also fire
  // mid-suite against a torn-down fake forge. Cheap to do, and it makes the
  // ingestion assertions mean what they say.
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('e2e globalSetup: REDIS_URL is not set — the ingestion worker needs it.');
  }
  const redis = createRedisConnection(redisUrl);
  const keys = await redis.keys('bull:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();

  // One login for the whole run. SC-11 caps the auth flow at 10 requests per
  // minute per IP, and a login per spec exhausts it the moment the suite grows
  // past a handful of files — which surfaced as an unrelated-looking
  // waitForURL timeout, not as a 429. Reusing the session is also simply
  // faster; the OAuth round trip itself is still covered, by the one spec in
  // auth.spec.ts that deliberately logs in with a fresh context.
  const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORTS.web}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/auth/login');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 15_000 });
  await mkdir(dirname(STORAGE_STATE), { recursive: true });
  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}

/**
 * Give the seeded forge connection a credential the vault can open.
 *
 * The seeder writes a four-byte placeholder (packages/shared has no vault), so
 * every scanner that fetches a tarball died with "ciphertext too short" and the
 * scan-scope spec could never see a successful snapshot scan. apps/api/src/demo.ts
 * does the same re-seal for demo mode. Only rows still carrying the seeder's
 * fingerprint are touched, so a connection an ingest spec made is left alone;
 * the address is the e2e fake forge's fixed port, the one the worker is given.
 */
async function sealSeededConnection(db: ReturnType<typeof createDb>): Promise<void> {
  if (process.env.SMOKE_REAL_FORGE === '1') return;
  const key = process.env.TOKEN_ENC_KEY;
  if (!key) throw new Error('e2e globalSetup: TOKEN_ENC_KEY is not set — the worker cannot open the seeded credential.');
  const sealed = credentials.encryptCredential(FAKE_TOKEN, Buffer.from(key, 'hex'));
  await db
    .update(core.forgeConnections)
    .set({
      credentialCiphertext: sealed.ciphertext,
      credentialIv: sealed.iv,
      keyVersion: sealed.keyVersion,
      credentialFingerprint: sealed.fingerprint,
      baseUrl: `http://127.0.0.1:${PORTS.e2eFakeForge}`,
    })
    .where(eq(core.forgeConnections.credentialFingerprint, 'seed:fp'));
}
