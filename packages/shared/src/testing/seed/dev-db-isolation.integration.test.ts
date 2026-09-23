import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, core } from '../../db/index.js';
import { seedWarehouse, unseedWarehouse } from './seed.js';

// W17-42: `pnpm test` must never touch the developer's database.
//
// The seed reset (wipeWorkspace) deletes every forge connection and repo in
// the Default workspace. That is correct for a database the suite owns and a
// data-loss bug for the one `.env` names: on 2026-09-23 the first `pnpm test`
// of fix/v1-residuals deleted a real GitHub connection from the dev DB.
//
// The dev URL is read from the repo-root `.env` directly, NOT from
// process.env — process.env is what the suite was pointed at, which is exactly
// the thing under test.

const ENV_FILE = new URL('../../../../../.env', import.meta.url);
const devUrl = existsSync(ENV_FILE) ? parse(readFileSync(ENV_FILE)).DATABASE_URL : undefined;
const suiteUrl = process.env.DATABASE_URL;

const dbName = (url: string): string => new URL(url).pathname.replace(/^\//, '');

// Both are needed: without a .env there is no developer database to protect,
// and without a suite URL the integration tier is not running at all.
const describeIfDevDb = devUrl && suiteUrl ? describe : describe.skip;

describeIfDevDb('the test suite is isolated from the developer database (W17-42)', () => {
  it('runs against a different database from the one .env names', () => {
    expect(dbName(suiteUrl!)).not.toBe(dbName(devUrl!));
  });

  it("a real forge connection in the dev DB's Default workspace survives the suite's seed reset", async () => {
    const devDb = createDb(devUrl!);
    const suiteDb = createDb(suiteUrl!);
    // A distinctive fingerprint so the cleanup below can only ever remove
    // this test's own row.
    const fingerprint = `w17-42-sentinel-${process.pid}-${Date.now()}`;
    try {
      const [ws] = await devDb
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'default'))
        .limit(1);
      // A dev DB that was never seeded or bootstrapped has no Default
      // workspace; creating one here would itself be writing to it.
      if (!ws) {
        console.warn('[w17-42] dev DB has no Default workspace — sentinel check not applicable');
        return;
      }
      // The one deliberate write to the dev DB: a sentinel standing in for the
      // developer's real connection, removed in `finally`.
      await devDb.insert(core.forgeConnections).values({
        workspaceId: ws.id,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('sentinel'),
        credentialIv: Buffer.from('iv-sentinel-0000'),
        keyVersion: 1,
        credentialFingerprint: fingerprint,
        status: 'active',
      });

      // What the suite does, against what the suite is pointed at.
      await seedWarehouse(suiteDb, { seed: 42 });
      await unseedWarehouse(suiteDb);

      const survivors = await devDb
        .select({ id: core.forgeConnections.id })
        .from(core.forgeConnections)
        .where(
          and(
            eq(core.forgeConnections.workspaceId, ws.id),
            eq(core.forgeConnections.credentialFingerprint, fingerprint),
          ),
        );
      expect(survivors, 'the developer connection must survive pnpm test').toHaveLength(1);
    } finally {
      await devDb
        .delete(core.forgeConnections)
        .where(eq(core.forgeConnections.credentialFingerprint, fingerprint));
      await devDb.$client.end();
      await suiteDb.$client.end();
    }
  }, 60_000);
});
