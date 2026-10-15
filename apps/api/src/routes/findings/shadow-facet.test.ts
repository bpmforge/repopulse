import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

// The shadow facet, the rule facet and the radar screen's read (W18-29),
// against a real Postgres.
//
// What matters is the default: a candidate rule's finding is a measurement in
// progress, and the explorer listed it beside active findings with nothing to
// tell them apart. The default now holds them back AND counts what it held
// back, so the screen can say "3 shadow findings hidden" rather than hiding
// them silently in the other direction.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const READER = 'w18-29-reader';
const RULE_ACTIVE = 'w18_29.active_rule';
const RULE_SHADOW = 'sensitive.cors_widened';

describeIfLiveInfra('shadow facet, rule facet and sensitive-change read (W18-29)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let connectionId: number;
  let readerUserId: number;
  let cookie: string;
  const repoIds: number[] = [];

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, cookies: { repopulse_sid: cookie } });
    expect(res.statusCode, url).toBe(200);
    return res.json() as Record<string, unknown>;
  };

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
      sessionSecret: 'w18-29-session-secret-that-is-long-enough-here',
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
        credentialFingerprint: 'w18-29-fp',
        status: 'active',
        createdBy: readerUserId,
      })
      .returning();
    connectionId = conn!.id;

    // Three repositories: one with signals, one never scanned by the radar,
    // one where an admin switched the radar off.
    for (const name of ['w18-29-signals', 'w18-29-unscanned', 'w18-29-off']) {
      const [repo] = await db
        .insert(core.repos)
        .values({
          workspaceId,
          connectionId,
          forgeRepoId: name,
          org: 'repopulse',
          name,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      repoIds.push(repo!.id);
    }
    const [signals, , off] = repoIds as [number, number, number];
    await db.insert(security.repoScannerConfig).values({
      workspaceId,
      repoId: off,
      scannerKey: 'sensitive_change',
      enabled: false,
    });

    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId: signals,
        scannerKey: 'sensitive_change',
        scannerVersion: 'test',
        commitSha: 'w18-29-sha',
        trigger: 'pr_synced',
        status: 'succeeded',
        finishedAt: new Date(),
      })
      .returning();

    const base = {
      workspaceId,
      repoId: signals,
      tier: 1,
      confidence: 3,
      file: 'src/app.ts',
      lineStart: 4,
      lineEnd: 4,
      evidence: '+ app.use(cors())',
      recommendation: 'review',
      status: 'open',
      // Every finding has a parent run (findings_run_parent_check).
      scanRunId: run!.id,
    };
    await db.insert(read.findings).values([
      {
        ...base,
        dimension: 'slop',
        severity: 2,
        title: 'active finding',
        dedupKey: 'w18-29-a',
        scannerKey: 'anti_slop',
        ruleId: RULE_ACTIVE,
        experimental: false,
      },
      {
        ...base,
        dimension: 'security',
        severity: 3,
        title: 'Needs human review: CORS widened to any origin',
        dedupKey: 'w18-29-s1',
        scannerKey: 'sensitive_change',
        ruleId: RULE_SHADOW,
        experimental: true,
      },
      {
        ...base,
        dimension: 'security',
        severity: 3,
        title: 'Needs human review: CORS widened again',
        file: 'src/other.ts',
        dedupKey: 'w18-29-s2',
        scannerKey: 'sensitive_change',
        ruleId: RULE_SHADOW,
        experimental: true,
      },
    ]);

    cookie = await loginAs(app, READER);
  });

  afterAll(async () => {
    await db.delete(read.findings).where(inArray(read.findings.repoId, repoIds));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.repoId, repoIds));
    await db
      .delete(security.repoScannerConfig)
      .where(inArray(security.repoScannerConfig.repoId, repoIds));
    await db.delete(core.repos).where(inArray(core.repos.id, repoIds));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, readerUserId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  type ListBody = {
    items: { title: string; experimental: boolean; rule_id: string | null }[];
    experimental: string;
    shadow_hidden: number | null;
  };

  it('holds shadow findings back by default, and says how many', async () => {
    const body = (await get(`/api/v1/findings?repo_id=${repoIds[0]}`)) as ListBody;
    expect(body.experimental).toBe('exclude');
    expect(body.items.map((f) => f.title)).toEqual(['active finding']);
    expect(body.shadow_hidden).toBe(2);
  });

  it('counts the hidden ones under the SAME filters, not the whole workspace', async () => {
    const body = (await get(`/api/v1/findings?repo_id=${repoIds[0]}&dimension=slop`)) as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.shadow_hidden).toBe(0);
  });

  it('experimental=only lists just the shadow findings, and hides nothing', async () => {
    const body = (await get(
      `/api/v1/findings?repo_id=${repoIds[0]}&experimental=only`,
    )) as ListBody;
    expect(body.items).toHaveLength(2);
    expect(body.items.every((f) => f.experimental)).toBe(true);
    expect(body.shadow_hidden).toBeNull();
  });

  it('experimental=include lists both, each still marked', async () => {
    const body = (await get(
      `/api/v1/findings?repo_id=${repoIds[0]}&experimental=include`,
    )) as ListBody;
    expect(body.items).toHaveLength(3);
    expect(body.items.filter((f) => f.experimental)).toHaveLength(2);
  });

  it('an unknown experimental value falls back to the safe default', async () => {
    const body = (await get(`/api/v1/findings?repo_id=${repoIds[0]}&experimental=yes`)) as ListBody;
    expect(body.experimental).toBe('exclude');
    expect(body.items).toHaveLength(1);
  });

  it('filters by rule id', async () => {
    const body = (await get(
      `/api/v1/findings?repo_id=${repoIds[0]}&rule_id=${RULE_SHADOW}&experimental=include`,
    )) as ListBody;
    expect(body.items).toHaveLength(2);
    expect(body.items.every((f) => f.rule_id === RULE_SHADOW)).toBe(true);
  });

  it('the rule facet keeps active and shadow counts apart', async () => {
    const body = (await get('/api/v1/findings/facets')) as {
      rules: { rule_id: string; scanner_key: string; active: number; shadow: number }[];
      shadow_total: number;
    };
    const active = body.rules.find((r) => r.rule_id === RULE_ACTIVE);
    expect(active).toMatchObject({ scanner_key: 'anti_slop', active: 1, shadow: 0 });
    const shadow = body.rules.find((r) => r.rule_id === RULE_SHADOW);
    expect(shadow?.shadow).toBeGreaterThanOrEqual(2);
    expect(body.shadow_total).toBeGreaterThanOrEqual(2);
  });

  type Radar = {
    repos: { total: number; enabled: number; disabled: { id: number }[] };
    runs: { ever: number; recent: number };
    rules: { rule_id: string; lifecycle: string; open_shadow: number }[];
    totals: { active: number; shadow: number };
    active: unknown[];
    shadow: { rule_id: string; repo: { name: string } }[];
  };

  it('the radar read separates shadow signals and reports coverage', async () => {
    const body = (await get(
      `/api/v1/security/sensitive-changes?repos=${repoIds.join(',')}`,
    )) as Radar;
    expect(body.repos).toMatchObject({ total: 3, enabled: 2 });
    expect(body.repos.disabled.map((r) => r.id)).toEqual([repoIds[2]]);
    expect(body.runs.ever).toBe(1);
    expect(body.runs.recent).toBe(1);
    expect(body.totals).toEqual({ active: 0, shadow: 2 });
    expect(body.active).toHaveLength(0);
    expect(body.shadow.map((s) => s.repo.name)).toEqual(['w18-29-signals', 'w18-29-signals']);
    const cors = body.rules.find((r) => r.rule_id === RULE_SHADOW);
    expect(cors).toMatchObject({ lifecycle: 'candidate', open_shadow: 2 });
    // Every radar rule is listed, signal or not: the screen names what it checks.
    expect(body.rules.length).toBeGreaterThanOrEqual(12);
  });

  it('a repository the radar never read says so: no runs, not "nothing found"', async () => {
    const body = (await get(`/api/v1/security/sensitive-changes?repos=${repoIds[1]}`)) as Radar;
    expect(body.runs.ever).toBe(0);
    expect(body.totals).toEqual({ active: 0, shadow: 0 });
  });
});
