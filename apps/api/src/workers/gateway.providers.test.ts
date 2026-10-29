import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb } from '@repopulse/shared';
import { createGatewayResolver } from './gateway.js';

// A gateway PER WORKSPACE (W16-19).
//
// The worker built ONE gateway at boot and handed it to every scan. Correct
// while hosts came from a global environment variable; wrong the moment
// providers became per-workspace rows (D-LLM-1). The failure it would produce
// is the shape this whole wave is about: a workspace whose configured model is
// quietly ignored, or — worse — another tenant's model and credential used to
// analyse its diffs.
//
// The env is passed EMPTY on purpose. This machine's .env sets LMSTUDIO_*, and
// the env fallback would hand a gateway to every workspace including the one
// that must not get one — so the test would pass while proving the opposite.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const NO_ENV = {} as NodeJS.ProcessEnv;
/**
 * NEVER USED, and worth saying so.
 *
 * The fixture row below has no credential columns — a LAN model legitimately
 * has no key — so `hostsFromProviders` skips the decrypt entirely and this
 * buffer is only there to satisfy the signature. So these tests prove the
 * right workspace's ROW is read; they do not prove the right workspace's
 * CREDENTIAL is decrypted, which is the more serious half of the leak W16-19
 * closes. Covering that needs a real sealed credential per workspace and a
 * vault key, which is the ticket after this one if it is ever worth the
 * fixture.
 */
const KEY = Buffer.alloc(32, 7);

describeIfLiveInfra('each workspace analyses on its own providers (W16-19)', () => {
  const db = createDb(databaseUrl as string);
  let withProvider = 0;
  let withoutProvider = 0;
  let userId = 0;

  beforeAll(async () => {
    // Own fixtures, whole chain. Two workspaces is the entire point, and
    // borrowing the seeder's would make this depend on file order (W16-17).
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w16-19-user',
        forgeUserId: 'w16-19-user',
        login: 'w16-19-user',
      })
      .onConflictDoNothing()
      .returning();
    userId =
      user?.id ??
      (
        await db
          .select({ id: core.users.id })
          .from(core.users)
          .where(eq(core.users.forgeUserId, 'w16-19-user'))
          .limit(1)
      )[0]!.id;

    const [a] = await db
      .insert(core.workspaces)
      .values({ slug: 'w16-19-a', name: 'W16-19 A' })
      .returning();
    const [b] = await db
      .insert(core.workspaces)
      .values({ slug: 'w16-19-b', name: 'W16-19 B' })
      .returning();
    withProvider = a!.id;
    withoutProvider = b!.id;

    // A LAN-shaped host, so the SC-24 private-range default accepts it without
    // the allow_public_host opt-out — this test is about whose provider is
    // used, not about the host policy.
    await db.insert(core.llmProviders).values({
      workspaceId: withProvider,
      name: 'W16-19 workstation',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.7:1234/v1',
      model: 'w16-19-model',
      enabled: true,
      createdBy: userId,
    });
  });

  afterAll(async () => {
    const ids = [withProvider, withoutProvider].filter(Boolean);
    await db.delete(core.llmProviders).where(inArray(core.llmProviders.workspaceId, ids));
    await db.delete(core.workspaces).where(inArray(core.workspaces.id, ids));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w16-19-user'));
    await db.$client.end();
  });

  it('builds a gateway from the workspace OWN provider row', async () => {
    const gateways = createGatewayResolver(db, NO_ENV, KEY);
    const built = await gateways.for(withProvider);

    expect(built, 'a configured workspace gets a gateway').not.toBeNull();
    expect(built!.source).toBe('providers');
    expect(built!.hosts.map((h) => h.modelSlot)).toContain('w16-19-model');
    expect(built!.hosts[0]?.baseUrl).toContain('10.0.0.7');
  });

  it('builds a separate background gateway for the judge, on the same providers', async () => {
    const gateways = createGatewayResolver(db, NO_ENV, KEY);
    const scans = await gateways.for(withProvider);
    const judge = await gateways.forBackground(withProvider);
    expect(judge).not.toBeNull();
    // Its own client: the judge's calls do not fill the scans' per-client cap.
    expect(judge!.gateway).not.toBe(scans!.gateway);
    expect(judge!.hosts.map((h) => h.modelSlot)).toEqual(scans!.hosts.map((h) => h.modelSlot));
    expect(await gateways.forBackground(withProvider)).toBe(judge);
    expect(await gateways.forBackground(withoutProvider)).toBeNull();
  });

  it('gives a workspace with no provider NOTHING, rather than the other one', async () => {
    // The borrowed-model case. Before W16-19 the worker passed the DEFAULT
    // workspace's id for every scan, so this workspace would have been analysed
    // on whatever the default had configured — another tenant's model, reached
    // with another tenant's credential.
    const gateways = createGatewayResolver(db, NO_ENV, KEY);
    const built = await gateways.for(withoutProvider);
    expect(built).toBeNull();
  });

  it('caches per workspace, and lets the cache expire', async () => {
    // Building one decrypts a credential and resolves every row, and a weekly
    // pass over forty repos would do it forty times. Expiring matters just as
    // much: D-LLM-1's premise is that you add a model in Settings → Models, and a
    // cache with no expiry would mean restarting the worker before it counts.
    let clock = 1_000;
    const gateways = createGatewayResolver(db, NO_ENV, KEY, {
      ttlMs: 5_000,
      now: () => clock,
    });

    const first = await gateways.for(withProvider);
    const cached = await gateways.for(withProvider);
    expect(cached, 'the same build is reused inside the TTL').toBe(first);

    clock += 6_000;
    const rebuilt = await gateways.for(withProvider);
    expect(rebuilt, 'past the TTL it is built again').not.toBe(first);
    expect(rebuilt!.hosts.map((h) => h.modelSlot)).toContain('w16-19-model');
  });

  it('caches the NULL too — a workspace with no provider is a settled answer', async () => {
    const gateways = createGatewayResolver(db, NO_ENV, KEY, { ttlMs: 5_000, now: () => 1_000 });
    expect(await gateways.for(withoutProvider)).toBeNull();
    // Re-deriving it per scan would query the table for every repo in a sweep
    // to reach the same nothing. `invalidate` is the way back, not a timeout
    // that pretends the answer might have changed between two repos.
    expect(await gateways.for(withoutProvider)).toBeNull();
    gateways.invalidate(withoutProvider);
    expect(await gateways.for(withoutProvider)).toBeNull();
  });

  it('forgets the NULL within seconds, so a model added in Settings → Models counts (W17-30)', async () => {
    // The journey hit this: worker boots → caches "no provider" for the
    // workspace → operator adds a model and presses Run scan inside the same
    // minute → "No model is configured … add one in Settings → Models". The null
    // must expire well before a built gateway does; a null is one SELECT.
    let clock = 1_000;
    const gateways = createGatewayResolver(db, NO_ENV, KEY, {
      ttlMs: 60_000,
      now: () => clock,
    });
    expect(await gateways.for(withoutProvider)).toBeNull();

    const [row] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: withoutProvider,
        name: 'W17-30 added later',
        kind: 'openai_compatible',
        baseUrl: 'http://10.0.0.8:1234/v1',
        model: 'w17-30-model',
        enabled: true,
        createdBy: userId,
      })
      .returning({ id: core.llmProviders.id });
    try {
      clock += 6_000;
      const built = await gateways.for(withoutProvider);
      expect(built, 'six seconds later the new provider is used').not.toBeNull();
      expect(built!.hosts.map((h) => h.modelSlot)).toContain('w17-30-model');
    } finally {
      await db.delete(core.llmProviders).where(eq(core.llmProviders.id, row!.id));
    }
  });
});
