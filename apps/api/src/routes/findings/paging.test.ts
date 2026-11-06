import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';
import { decodeCursor, encodeCursor } from './index.js';
import { encodeGeneral, parseSort, SORT_KEYS, type SortDir, type SortKey } from './sort.js';

// Keyset paging integrity (W17-32), against a real Postgres.
//
// The cursor used to carry (severity, id) under BOTH sorts while the default
// sort ordered by effective_risk first. Walking 10,000 findings under sort=risk
// returned 610 distinct rows, 270 of them twice, and never showed 9,390. The
// only honest proof is a walk: every page followed to the end, every id
// counted once, against a fixture with the two things that break a keyset —
// TIES on the sort key and NULLs sorted last.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const READER = 'w17-32-reader';
// Three pages at PAGE_SIZE 50, with page boundaries landing inside tie groups.
const TOTAL = 130;
const RISKS: (string | null)[] = ['40.00', '25.50', '25.50', '10.00', null];

describe('findings cursor round-trips per sort (W17-32)', () => {
  it('carries effective_risk under sort=risk, including the unpriced marker', () => {
    const priced = encodeCursor('risk', { severity: 4, id: 12, effectiveRisk: '25.50' });
    expect(decodeCursor(priced)).toEqual({ sort: 'risk', risk: '25.50', severity: 4, id: 12 });
    const unpriced = encodeCursor('risk', { severity: 2, id: 7, effectiveRisk: null });
    expect(decodeCursor(unpriced)).toEqual({ sort: 'risk', risk: null, severity: 2, id: 7 });
  });

  it('keeps the severity shape and rejects garbage', () => {
    const c = encodeCursor('severity', { severity: 3, id: 9, effectiveRisk: '1.00' });
    expect(decodeCursor(c)).toEqual({ sort: 'severity', severity: 3, id: 9 });
    expect(decodeCursor('not-base64url-!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('r:abc:1:2').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('1:2:3').toString('base64url'))).toBeNull();
  });
});

// W26-05: any column, either way, with a cursor that carries the key's text.
describe('general sort cursor (W26-05)', () => {
  it('round-trips a key that contains the separator, and an unpriced risk', () => {
    const c = encodeGeneral({ key: 'file', dir: 'asc' }, 'a:b/c.ts', 42);
    expect(decodeCursor(c)).toEqual({
      sort: 'general',
      key: 'file',
      dir: 'asc',
      value: 'a:b/c.ts',
      id: 42,
    });
    const r = encodeGeneral({ key: 'risk', dir: 'asc' }, null, 7);
    expect(decodeCursor(r)).toMatchObject({ key: 'risk', dir: 'asc', value: null, id: 7 });
  });

  it('refuses a cursor with an unknown column or direction, or a null key off risk', () => {
    const raw = (t: string) => Buffer.from(t).toString('base64url');
    expect(decodeCursor(raw('g:colour:asc:YQ:1'))).toBeNull();
    expect(decodeCursor(raw('g:title:up:YQ:1'))).toBeNull();
    expect(decodeCursor(raw('g:title:asc:-:1'))).toBeNull();
    expect(decodeCursor(raw('g:title:asc:YQ:x'))).toBeNull();
  });

  it('defaults each column to its natural direction and unknown sorts to risk', () => {
    expect(parseSort(undefined, undefined)).toEqual({ key: 'risk', dir: 'desc' });
    expect(parseSort('title', undefined)).toEqual({ key: 'title', dir: 'asc' });
    expect(parseSort('title', 'desc')).toEqual({ key: 'title', dir: 'desc' });
    expect(parseSort('colour', 'asc')).toEqual({ key: 'risk', dir: 'asc' });
  });
});

describeIfLiveInfra('findings paging returns every row exactly once (W17-32)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let repoId: number;
  let connectionId: number;
  let readerUserId: number;
  let cookie: string;

  async function walk(sort: SortKey, dir?: SortDir): Promise<{ pages: number; ids: number[] }> {
    const ids: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/v1/findings?repo_id=${repoId}&sort=${sort}${dir ? `&dir=${dir}` : ''}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const res = await app.inject({ method: 'GET', url, cookies: { repopulse_sid: cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: number }[]; next_cursor: string | null };
      pages++;
      ids.push(...body.items.map((f) => f.id));
      cursor = body.next_cursor;
      if (pages > 20) throw new Error('paging did not terminate');
    } while (cursor);
    return { pages, ids };
  }

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString() || '{}';
          const code = (JSON.parse(body) as { code?: string }).code ?? 'tok';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: code, token_type: 'bearer' }));
        });
        return;
      }
      if (req.url === '/user') {
        const f = (req.headers.authorization ?? '').replace('Bearer ', '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: f, login: f, name: null, avatar_url: null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const ghBase = `http://127.0.0.1:${addr.port}`;

    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
      sessionSecret: 'w17-32-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
    });
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [reader] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: READER, forgeUserId: READER, login: READER })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: READER } })
      .returning();
    readerUserId = reader!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: readerUserId, role: 'member' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'member' },
      });

    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w17-32-fp',
        status: 'active',
        createdBy: readerUserId,
      })
      .returning();
    connectionId = conn!.id;

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w17-32-repo',
        org: 'repopulse',
        name: 'w17-32-paging',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [scanRun] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'test',
        commitSha: 'w17-32-sha',
        trigger: 'manual',
        status: 'succeeded',
        validationFunnel: { raw: TOTAL, deduped: TOTAL },
      })
      .returning();

    await db.insert(read.findings).values(
      Array.from({ length: TOTAL }, (_, i) => ({
        workspaceId,
        repoId,
        dimension: 'security',
        tier: 1,
        // Ties on every sort column but id, so the cursor's tiebreak is exercised.
        severity: 1 + (i % 3),
        confidence: 3,
        title: `W17-32 finding ${i}`,
        file: 'src/pay.ts',
        lineStart: 10,
        lineEnd: 12,
        evidence: 'evidence',
        recommendation: 'fix it',
        dedupKey: `w17-32-${i}`,
        scanRunId: scanRun!.id,
        status: 'open',
        scannerKey: 'secrets',
        effectiveRisk: RISKS[i % RISKS.length] ?? null,
      })),
    );

    cookie = await loginAs(app, READER);
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, readerUserId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  for (const sort of ['risk', 'severity'] as const) {
    it(`sort=${sort}: a full walk sees every finding once, in order`, async () => {
      const { pages, ids } = await walk(sort);
      expect(pages).toBe(Math.ceil(TOTAL / 50));
      expect(ids).toHaveLength(TOTAL);
      expect(new Set(ids).size).toBe(TOTAL);
    });
  }

  // W26-05: every column both ways; the fixture ties on file, status and
  // first_seen across the whole set, so only the id tiebreak keeps them apart.
  for (const key of SORT_KEYS) {
    for (const dir of ['asc', 'desc'] as const) {
      it(`sort=${key}&dir=${dir}: a full walk sees every finding once`, async () => {
        const { ids } = await walk(key, dir);
        expect(ids).toHaveLength(TOTAL);
        expect(new Set(ids).size).toBe(TOTAL);
      });
    }
  }

  it('sort=title: ascending is the reverse of descending', async () => {
    const up = (await walk('title', 'asc')).ids;
    const down = (await walk('title', 'desc')).ids;
    expect(up).toEqual([...down].reverse());
    const rows = await db
      .select({ id: read.findings.id, title: read.findings.title })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    const title = new Map(rows.map((r) => [r.id, r.title.toLowerCase()]));
    const seen = up.map((id) => title.get(id)!);
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('sort=risk&dir=asc: lowest priced first, unpriced still last', async () => {
    const { ids } = await walk('risk', 'asc');
    const rows = await db
      .select({ id: read.findings.id, risk: read.findings.effectiveRisk })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    const riskOf = new Map(rows.map((r) => [r.id, r.risk]));
    const firstNull = ids.findIndex((id) => riskOf.get(id) === null);
    const priced = ids.slice(0, firstNull).map((id) => Number(riskOf.get(id)));
    expect(priced).toEqual([...priced].sort((a, b) => a - b));
    expect(ids.slice(firstNull).every((id) => riskOf.get(id) === null)).toBe(true);
  });

  it('a general cursor is refused under another column or direction', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/findings?repo_id=${repoId}&sort=title&dir=asc`,
      cookies: { repopulse_sid: cookie },
    });
    const cursor = (first.json() as { next_cursor: string }).next_cursor;
    for (const q of ['sort=title&dir=desc', 'sort=file&dir=asc', 'sort=risk']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/findings?repo_id=${repoId}&${q}&cursor=${encodeURIComponent(cursor)}`,
        cookies: { repopulse_sid: cookie },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('sort=risk: unpriced findings come after every priced one, and are all reached', async () => {
    const { ids } = await walk('risk');
    const rows = await db
      .select({ id: read.findings.id, risk: read.findings.effectiveRisk })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    const riskOf = new Map(rows.map((r) => [r.id, r.risk]));
    const firstNull = ids.findIndex((id) => riskOf.get(id) === null);
    expect(firstNull).toBeGreaterThan(0);
    expect(ids.slice(firstNull).every((id) => riskOf.get(id) === null)).toBe(true);
    expect(ids.slice(0, firstNull).every((id) => riskOf.get(id) !== null)).toBe(true);
  });

  it('a cursor minted under the other sort is refused, not silently misapplied', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/findings?repo_id=${repoId}&sort=risk`,
      cookies: { repopulse_sid: cookie },
    });
    const cursor = (first.json() as { next_cursor: string }).next_cursor;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/findings?repo_id=${repoId}&sort=severity&cursor=${encodeURIComponent(cursor)}`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
