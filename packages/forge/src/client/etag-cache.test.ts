import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@repopulse/shared';
import { computeEndpointKey, EtagCache } from './etag-cache.js';
import {
  cleanupFixture,
  createDb,
  databaseUrl,
  seedWorkspaceAndConnection,
  type SeededFixture,
} from './test-fixtures.js';

const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('EtagCache (FR-FORGE-4)', () => {
  let db: Database;
  let fixture: SeededFixture;
  let cache: EtagCache;

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    fixture = await seedWorkspaceAndConnection(db, {
      workspaceSlug: 'w1-05-etag-test',
      forgeUserId: 'w1-05-etag-test-user',
    });
    cache = new EtagCache({
      db,
      connectionId: fixture.connectionId,
      workspaceId: fixture.workspaceId,
    });
  });

  afterAll(async () => {
    await cleanupFixture(db, fixture);
    await db.$client.end();
  });

  it('returns null for an endpoint never fetched', async () => {
    const entry = await cache.lookup(computeEndpointKey('GET', '/repos/acme/widgets/pulls'));
    expect(entry).toBeNull();
  });

  it('stores and round-trips an entry', async () => {
    const key = computeEndpointKey('GET', '/repos/acme/widgets/commits', { since: '2026-01-01' });
    await cache.store(key, {
      etag: 'W/"abc123"',
      lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT',
      status: 200,
      body: { items: [1, 2, 3] },
    });
    const entry = await cache.lookup(key);
    expect(entry).toMatchObject({
      etag: 'W/"abc123"',
      lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT',
      lastStatus: 200,
      cachedBody: { items: [1, 2, 3] },
    });
    expect(entry?.bodyDigest).toBeTruthy();
  });

  it('upserts on repeated store() for the same endpoint key', async () => {
    const key = computeEndpointKey('GET', '/repos/acme/widgets/pulls', { page: 1 });
    await cache.store(key, { etag: '"v1"', lastModified: null, status: 200, body: { n: 1 } });
    await cache.store(key, { etag: '"v2"', lastModified: null, status: 200, body: { n: 2 } });
    const entry = await cache.lookup(key);
    expect(entry?.etag).toBe('"v2"');
    expect(entry?.cachedBody).toEqual({ n: 2 });
  });

  it('computeEndpointKey ignores param key order', () => {
    const a = computeEndpointKey('GET', '/x', { b: 2, a: 1 });
    const b = computeEndpointKey('GET', '/x', { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('computeEndpointKey is sensitive to method and path', () => {
    const get = computeEndpointKey('GET', '/x');
    const post = computeEndpointKey('POST', '/x');
    const other = computeEndpointKey('GET', '/y');
    expect(get).not.toBe(post);
    expect(get).not.toBe(other);
  });
});
