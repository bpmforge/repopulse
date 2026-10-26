import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  core,
  createDb,
  facts,
  read,
  redactLine,
  security,
  trackRoutes,
  type Database,
  type DiscoveredRoute,
  type Logger,
} from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';
import { bearerFrom, hashCiToken, mintCiToken } from '../../lib/ci-token.js';
import { decodePrCursor, encodePrCursor, severityLabel } from './new-findings.js';

// W18-18 (D16 CI pull), against a real Postgres: the "new on this PR"
// computation, the read-only CI token, and the admin surface that mints it.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const ADMIN = 'w18-18-admin';
const MEMBER = 'w18-18-member';
const XRW = { 'x-requested-with': 'repopulse' };

describe('ci token helpers', () => {
  it('mints rpci_ tokens with 256 random bits, stored only as a sha256', () => {
    const a = mintCiToken();
    const b = mintCiToken();
    expect(a.token).toMatch(/^rpci_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashCiToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.displayPrefix).toBe(a.token.slice(0, 13));
  });

  it('treats a present-but-malformed Authorization header as a failed token, not as absent', () => {
    expect(bearerFrom(undefined)).toBeNull();
    expect(bearerFrom('Bearer rpci_abc')).toBe('rpci_abc');
    expect(bearerFrom('bearer rpci_abc')).toBe('rpci_abc');
    expect(bearerFrom('Basic dXNlcjpwYXNz')).toBe('');
    expect(bearerFrom('Bearer')).toBe('');
  });

  it('round-trips the page cursor and names severities like the UI', () => {
    expect(decodePrCursor(encodePrCursor({ severity: 4, id: 99 }))).toEqual({
      severity: 4,
      id: 99,
    });
    expect(decodePrCursor('garbage!')).toBeNull();
    expect([1, 2, 3, 4, 5].map(severityLabel)).toEqual([
      'info',
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });
});

function capturedLogger(): { logger: Logger; raw: () => string } {
  let raw = '';
  const dest = new Writable({
    write(chunk, _enc, cb) {
      raw += chunk.toString();
      cb();
    },
  });
  const logger = pino(
    { hooks: { streamWrite: (s: string) => redactLine(s) } },
    dest as unknown as pino.DestinationStream,
  );
  return { logger, raw: () => raw };
}

describeIfLiveInfra('CI pull: PR findings API + read-only CI token (W18-18)', () => {
  const db: Database = createDb(databaseUrl as string);
  const log = capturedLogger();
  let app: ReturnType<typeof buildApp>;
  let routes: () => DiscoveredRoute[];
  let githubMock: Server;
  let workspaceId: number;
  let connectionId: number;
  let repoA: number;
  let repoB: number;
  let prId: number;
  const userIds: number[] = [];
  let adminCookie: string;
  let memberCookie: string;
  let token: string;
  let tokenId: number;
  const ids: Record<string, number> = {};

  // T0 < T1: the PR's first and second push. A finding last seen at T0 by a
  // scanner that ran again at T1 was fixed by the second push.
  const T0 = new Date(Date.now() - 60 * 60 * 1000);
  const T1 = new Date(Date.now() - 30 * 60 * 1000);
  const AFTER_T1 = new Date(Date.now() - 29 * 60 * 1000);
  const HEAD = 'w18-18-head-2';

  async function get(url: string, auth: { token?: string; cookie?: string }) {
    return app.inject({
      method: 'GET',
      url,
      ...(auth.token ? { headers: { authorization: `Bearer ${auth.token}` } } : {}),
      ...(auth.cookie ? { cookies: { repopulse_sid: auth.cookie } } : {}),
    });
  }

  function findingsUrl(repo: number, query = '') {
    return `/api/v1/repos/${repo}/pulls/7/findings${query ? `?${query}` : ''}`;
  }

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const code = (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { code?: string })
            .code;
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
      redisUrl: redisUrl as string,
      sessionSecret: 'w18-18-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
      loggerInstance: log.logger,
    });
    // Before ready(): plugins register their routes during ready, so this sees all of them.
    routes = trackRoutes(app as unknown as Parameters<typeof trackRoutes>[0]);
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    for (const [login, role] of [
      [ADMIN, 'admin'],
      [MEMBER, 'member'],
    ] as const) {
      const [u] = await db
        .insert(core.users)
        .values({ authProvider: 'github', authSubject: login, forgeUserId: login, login })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login } })
        .returning();
      userIds.push(u!.id);
      await db
        .insert(core.workspaceMembers)
        .values({ workspaceId, userId: u!.id, role })
        .onConflictDoUpdate({
          target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
          set: { role },
        });
    }

    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w18-18-fp',
        status: 'active',
        createdBy: userIds[0]!,
      })
      .returning();
    connectionId = conn!.id;

    const repoRow = (name: string) => ({
      workspaceId,
      connectionId,
      forgeRepoId: `w18-18-${name}`,
      org: 'acme',
      name,
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    });
    const [a] = await db.insert(core.repos).values(repoRow('payments')).returning();
    const [b] = await db.insert(core.repos).values(repoRow('ledger')).returning();
    repoA = a!.id;
    repoB = b!.id;

    const [ident] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w18-18-dev',
        forgeUserId: 'w18-18-dev',
        displayName: 'dev',
      })
      .returning();
    const prRow = (repoId: number) => ({
      workspaceId,
      repoId,
      number: 7,
      forgePrId: `w18-18-pr-${repoId}`,
      title: 'Add refunds',
      authorIdentityId: ident!.id,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: T0,
      updatedAt: T1,
      baseRef: 'main',
      headSha: HEAD,
      additions: 10,
      deletions: 2,
      changedFiles: 2,
    });
    const [pr] = await db.insert(facts.pullRequests).values(prRow(repoA)).returning();
    const [prB] = await db.insert(facts.pullRequests).values(prRow(repoB)).returning();
    prId = pr!.id;
    await db.insert(facts.prFiles).values([
      {
        workspaceId,
        repoId: repoA,
        pullRequestId: prId,
        path: 'src/legacy.ts',
        additions: 1,
        deletions: 0,
        changeType: 'modified',
      },
    ]);

    const run = async (
      scannerKey: string,
      commitSha: string,
      trigger: string,
      startedAt: Date,
      status = 'succeeded',
    ) => {
      const [r] = await db
        .insert(security.scanRuns)
        .values({
          workspaceId,
          repoId: repoA,
          scannerKey,
          scannerVersion: 'test',
          commitSha,
          trigger,
          status,
          startedAt,
        })
        .returning();
      return r!.id;
    };
    const slopFirstPush = await run('anti_slop', 'w18-18-head-1', 'pr_synced', T0);
    await run('anti_slop', HEAD, 'pr_synced', T1);
    const semgrepHead = await run('semgrep', HEAD, 'pr_synced', T1);
    const semgrepBase = await run('semgrep', 'w18-18-main', 'schedule', T0);
    const loggingFirstPush = await run('logging_hygiene', 'w18-18-head-1', 'pr_synced', T0);
    // A failed run at the head proves nothing about presence and must not count.
    await run('logging_hygiene', HEAD, 'pr_synced', T1, 'failed');

    const base = {
      workspaceId,
      repoId: repoA,
      tier: 1,
      confidence: 4,
      evidence: 'evidence',
      recommendation: 'fix it',
      status: 'open',
      dimension: 'security',
      file: 'src/refunds.ts',
      lineStart: 10,
      lineEnd: 12,
    };
    const insert = async (key: string, row: Partial<typeof read.findings.$inferInsert>) => {
      const [f] = await db
        .insert(read.findings)
        .values({ ...base, title: key, dedupKey: `w18-18-${key}`, severity: 3, ...row })
        .returning();
      ids[key] = f!.id;
    };
    // Introduced by the PR (stamped), still present at the head.
    await insert('new_on_head', {
      severity: 4,
      scannerKey: 'anti_slop',
      ruleId: 'slop.unused-export',
      scanRunId: slopFirstPush,
      pullRequestId: prId,
      firstSeenAt: T0,
      lastSeenAt: AFTER_T1,
      dimension: 'slop',
    });
    // Introduced on the first push, fixed by the second: not bumped by the head run.
    await insert('fixed_on_head', {
      severity: 5,
      scannerKey: 'anti_slop',
      ruleId: 'slop.phantom-ref',
      scanRunId: slopFirstPush,
      pullRequestId: prId,
      firstSeenAt: T0,
      lastSeenAt: T0,
      dimension: 'slop',
    });
    // First seen by the incremental semgrep run AT THE HEAD (no PR stamp).
    await insert('semgrep_head', {
      severity: 5,
      scannerKey: 'semgrep',
      ruleId: 'bpm-sql-injection',
      scanRunId: semgrepHead,
      firstSeenAt: AFTER_T1,
      lastSeenAt: AFTER_T1,
    });
    // On the base already; the PR touches its file. Not new.
    await insert('preexisting', {
      severity: 4,
      scannerKey: 'semgrep',
      ruleId: 'bpm-weak-hash',
      scanRunId: semgrepBase,
      file: 'src/legacy.ts',
      firstSeenAt: T0,
      lastSeenAt: AFTER_T1,
    });
    // On the base, in a file the PR does not touch: never in either answer.
    await insert('elsewhere', {
      severity: 4,
      scannerKey: 'semgrep',
      ruleId: 'bpm-weak-hash',
      scanRunId: semgrepBase,
      file: 'src/other.ts',
      firstSeenAt: T0,
      lastSeenAt: AFTER_T1,
    });
    // Shadow-mode rule: excluded unless asked for.
    await insert('experimental', {
      severity: 2,
      scannerKey: 'anti_slop',
      ruleId: 'slop.candidate',
      scanRunId: slopFirstPush,
      pullRequestId: prId,
      experimental: true,
      lastSeenAt: AFTER_T1,
      dimension: 'slop',
    });
    // A person dismissed it: CI must not keep failing on it.
    await insert('dismissed', {
      severity: 5,
      scannerKey: 'anti_slop',
      ruleId: 'slop.dismissed',
      scanRunId: slopFirstPush,
      pullRequestId: prId,
      status: 'dismissed',
      dismissReason: 'false_positive',
      lastSeenAt: AFTER_T1,
      dimension: 'slop',
    });
    // Its scanner has not succeeded at the head: kept, flagged seen_at_head=false.
    await insert('unscanned_scanner', {
      severity: 2,
      scannerKey: 'logging_hygiene',
      ruleId: 'bpm-log-console',
      scanRunId: loggingFirstPush,
      pullRequestId: prId,
      lastSeenAt: T0,
      dimension: 'logging',
    });
    // Repo B's PR #7: a token for repo A must never see it.
    await db.insert(read.findings).values({
      ...base,
      repoId: repoB,
      title: 'repo-b',
      dedupKey: 'w18-18-repo-b',
      severity: 5,
      scanRunId: semgrepBase,
      pullRequestId: prB!.id,
    });

    adminCookie = await loginAs(app, ADMIN);
    memberCookie = await loginAs(app, MEMBER);
  });

  afterAll(async () => {
    await db.delete(core.ciTokens).where(eq(core.ciTokens.workspaceId, workspaceId));
    await db.delete(read.findings).where(inArray(read.findings.repoId, [repoA, repoB]));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoA));
    await db.delete(facts.prFiles).where(eq(facts.prFiles.repoId, repoA));
    await db.delete(facts.pullRequests).where(inArray(facts.pullRequests.repoId, [repoA, repoB]));
    await db.delete(core.identities).where(eq(core.identities.forgeLogin, 'w18-18-dev'));
    await db.delete(core.repos).where(inArray(core.repos.id, [repoA, repoB]));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaceMembers).where(inArray(core.workspaceMembers.userId, userIds));
    await db.delete(core.users).where(inArray(core.users.id, userIds));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  // --- the admin surface ------------------------------------------------------

  it('a member cannot mint a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ci-tokens',
      headers: XRW,
      cookies: { repopulse_sid: memberCookie },
      payload: { name: 'nope', repo_ids: [repoA] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a token naming no repository, or one outside the workspace', async () => {
    for (const repo_ids of [[], [repoA, 999_999_999], 'all']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ci-tokens',
        headers: XRW,
        cookies: { repopulse_sid: adminCookie },
        payload: { name: 'bad', repo_ids },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('an admin mints a token: shown once, hashed at rest, audited without the secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ci-tokens',
      headers: XRW,
      cookies: { repopulse_sid: adminCookie },
      payload: { name: 'payments CI', repo_ids: [repoA, repoA], expires_in_days: 30 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: number; token: string; repo_ids: number[]; scope: string };
    token = body.token;
    tokenId = body.id;
    expect(token).toMatch(/^rpci_/);
    expect(body.repo_ids).toEqual([repoA]);
    expect(body.scope).toBe('pr_findings:read');

    const [row] = await db.select().from(core.ciTokens).where(eq(core.ciTokens.id, tokenId));
    expect(row!.tokenHash).toBe(hashCiToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.createdByLogin).toBe(ADMIN);
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    // Never again: the list carries the prefix only.
    const list = await get('/api/v1/admin/ci-tokens', { cookie: adminCookie });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(row!.tokenHash);
    expect(list.json().items[0]).toMatchObject({ id: tokenId, prefix: token.slice(0, 13) });

    const audit = log
      .raw()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event?: string; audit?: boolean; actorUserId?: number })
      .find((l) => l.event === 'ci_token.created');
    expect(audit).toMatchObject({ audit: true, actorUserId: userIds[0] });
    expect(log.raw()).not.toContain(token);
  });

  // --- the "new on this PR" answer ---------------------------------------------

  it('returns exactly what the PR introduced and is still on its head', async () => {
    const res = await get(findingsUrl(repoA, 'new=true'), { token });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pull: { number: number; head_sha: string };
      head: {
        scanned: boolean;
        scanners: { scanner_key: string }[];
        pending: string[];
        failed: string[];
      };
      items: {
        id: number;
        introduced_by_pr: boolean;
        seen_at_head: boolean;
        severity_label: string;
      }[];
      next_cursor: string | null;
    };
    expect(body.pull).toMatchObject({ number: 7, head_sha: HEAD });
    // W20-15 (UX_TODO X-13): anti_slop and semgrep have finished at the head,
    // and logging_hygiene failed there, but the other scanners that run on
    // every PR push (W21-02: performance; the secrets stream and the radar and,
    // since W21-05, slopsquat that ride it) have not, so the head is NOT
    // scanned yet and says which. dependency_cve is not waited for: it runs on
    // a PR only when the change touched a manifest, and it has not started here.
    expect(body.head.scanned).toBe(false);
    expect(body.head.pending).toEqual(['performance', 'secrets', 'sensitive_change', 'slopsquat']);
    expect(body.head.failed).toEqual(['logging_hygiene']);
    expect(body.head.scanners.map((s) => s.scanner_key)).toEqual(['anti_slop', 'semgrep']);
    // Severity desc, then id desc.
    expect(body.items.map((i) => i.id)).toEqual([
      ids['semgrep_head'],
      ids['new_on_head'],
      ids['unscanned_scanner'],
    ]);
    expect(body.items.every((i) => i.introduced_by_pr)).toBe(true);
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(ids['new_on_head']!)!.seen_at_head).toBe(true);
    expect(byId.get(ids['unscanned_scanner']!)!.seen_at_head).toBe(false);
    expect(byId.get(ids['semgrep_head']!)!.severity_label).toBe('critical');
    expect(body.next_cursor).toBeNull();
  });

  it('reports the head scanned once every PR scanner has finished there (X-13)', async () => {
    const at = new Date(T1.getTime() + 1000);
    const finish = (scannerKey: string, status: string) =>
      db.insert(security.scanRuns).values({
        workspaceId,
        repoId: repoA,
        scannerKey,
        scannerVersion: 'test',
        commitSha: HEAD,
        trigger: 'pr_synced',
        status,
        startedAt: at,
      });
    await finish('secrets', 'succeeded');
    await finish('performance', 'succeeded');
    const partial = (await get(findingsUrl(repoA), { token })).json() as {
      head: { scanned: boolean; pending: string[] };
    };
    expect(partial.head).toMatchObject({
      scanned: false,
      pending: ['sensitive_change', 'slopsquat'],
    });

    // W21-02: a conditional scanner that HAS started at the head (the PR
    // changed a lockfile) is waited for until it finishes.
    await finish('dependency_cve', 'running');
    const waiting = (await get(findingsUrl(repoA), { token })).json() as {
      head: { scanned: boolean; pending: string[] };
    };
    expect(waiting.head.pending).toEqual(['dependency_cve', 'sensitive_change', 'slopsquat']);
    await finish('dependency_cve', 'succeeded');

    // A failed run is finished: the verdict is not held for ever, but the
    // failure is named so the caller knows what is missing.
    await finish('slopsquat', 'succeeded');
    await finish('sensitive_change', 'failed');
    const done = (await get(findingsUrl(repoA), { token })).json() as {
      head: { scanned: boolean; pending: string[]; failed: string[] };
    };
    expect(done.head).toMatchObject({
      scanned: true,
      pending: [],
      failed: ['logging_hygiene', 'sensitive_change'],
    });
  });

  it('carries the fields a CI needs to act on', async () => {
    const res = await get(findingsUrl(repoA), { token });
    const first = (res.json() as { items: Record<string, unknown>[] }).items[0]!;
    expect(Object.keys(first).sort()).toEqual(
      [
        'confidence',
        'dimension',
        'evidence',
        'experimental',
        'file',
        'first_seen_at',
        'found_by',
        'id',
        'introduced_by_pr',
        'last_seen_at',
        'line_end',
        'line_start',
        'rule_id',
        'scanner_key',
        'seen_at_head',
        'severity',
        'severity_label',
        'status',
        'suggested_fix',
        'title',
      ].sort(),
    );
    expect(first).toMatchObject({
      rule_id: 'bpm-sql-injection',
      file: 'src/refunds.ts',
      line_start: 10,
      suggested_fix: 'fix it',
      experimental: false,
    });
    // W21-01: attributed like GET /findings, so both screens can say it the
    // same way — never just the bare scanner key.
    expect(first.found_by).toMatchObject({ kind: expect.stringMatching(/scanner|model|imported/) });
    if ((first.found_by as { kind: string }).kind === 'scanner') {
      expect(first.found_by).toMatchObject({ scanner: first.scanner_key });
    }
  });

  it('include_experimental=true adds the shadow-mode finding, and only it', async () => {
    const res = await get(findingsUrl(repoA, 'include_experimental=true'), { token });
    const got = (res.json() as { items: { id: number; experimental: boolean }[] }).items;
    expect(got.map((i) => i.id)).toContain(ids['experimental']);
    expect(got.filter((i) => i.experimental).map((i) => i.id)).toEqual([ids['experimental']]);
    expect(got).toHaveLength(4);
  });

  it('new=false adds pre-existing findings on touched files, marked as not introduced', async () => {
    const res = await get(findingsUrl(repoA, 'new=false'), { token });
    const got = (res.json() as { items: { id: number; introduced_by_pr: boolean }[] }).items;
    const pre = got.find((i) => i.id === ids['preexisting']);
    expect(pre?.introduced_by_pr).toBe(false);
    expect(got.map((i) => i.id)).not.toContain(ids['elsewhere']);
    expect(got.map((i) => i.id)).not.toContain(ids['fixed_on_head']);
    expect(got).toHaveLength(4);
  });

  it('pages with a cursor, every finding exactly once', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `include_experimental=true&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await get(findingsUrl(repoA, q), { token });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: number }[]; next_cursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(4);
    const bad = await get(findingsUrl(repoA, 'cursor=bm9wZQ'), { token });
    expect(bad.statusCode).toBe(400);
  });

  it('a signed-in member gets the same answer without a token', async () => {
    const res = await get(findingsUrl(repoA), { cookie: memberCookie });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(3);
  });

  it('404s an unsynced PR with a message the CI can act on', async () => {
    const res = await get(`/api/v1/repos/${repoA}/pulls/4242/findings`, { token });
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toMatch(/no pull request #4242/);
    // Its own problem type, so the CLI keeps waiting on it (W20-15, X-14)
    // and never confuses it with a token that does not name the repository.
    expect(res.json().type).toBe('urn:repopulse:problem:pr-not-synced');
  });

  // --- what the token cannot do ------------------------------------------------

  it('reads only the repositories it names — another repo is a 404, not a 403', async () => {
    const res = await get(findingsUrl(repoB), { token });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('repo-b');
    expect(res.json().type).toBe('about:blank');
  });

  it('cannot call ANY other /api/v1 endpoint, read or write (full route walk)', async () => {
    const allowed = new Set([
      'GET /api/v1/repos/:id/pulls/:number/findings',
      'GET /api/v1/cli/repopulse.mjs',
    ]);
    const walked = routes().filter(
      (r) =>
        r.url.startsWith('/api/v1/') &&
        // Not behind the /api/v1 guard at all: authenticated by HMAC, and the
        // spec, which is public by design (app.ts).
        !r.url.startsWith('/api/v1/webhooks') &&
        r.url !== '/api/v1/openapi.json',
    );
    expect(walked.length).toBeGreaterThan(50);
    const leaks: string[] = [];
    for (const r of walked) {
      const key = `${r.method} ${r.url}`;
      if (allowed.has(key)) continue;
      const url = r.url.replace(/:[a-zA-Z_]+/g, String(repoA)).replace(/\*$/, 'x');
      const res = await app.inject({
        method: r.method as 'GET',
        url,
        headers: { authorization: `Bearer ${token}`, ...XRW },
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
      });
      if (res.statusCode !== 403) leaks.push(`${key} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
    // The walk saw the allowed routes too, so the allowlist is not stale.
    const seen = new Set(walked.map((r) => `${r.method} ${r.url}`));
    for (const a of allowed) expect(seen.has(a)).toBe(true);
  }, 60_000);

  it('a token cannot mint, revoke or transition anything', async () => {
    const before = await db
      .select()
      .from(core.ciTokens)
      .where(eq(core.ciTokens.workspaceId, workspaceId));
    for (const [method, url, payload] of [
      ['POST', '/api/v1/admin/ci-tokens', { name: 'escalate', repo_ids: [repoA, repoB] }],
      ['DELETE', `/api/v1/admin/ci-tokens/${tokenId}`, undefined],
      ['PATCH', `/api/v1/findings/${ids['new_on_head']}`, { status: 'resolved', note: 'x' }],
      ['POST', '/api/v1/findings/bulk', { ids: [ids['new_on_head']], status: 'resolved' }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, ...XRW },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
    const after = await db
      .select()
      .from(core.ciTokens)
      .where(eq(core.ciTokens.workspaceId, workspaceId));
    expect(after).toHaveLength(before.length);
    const [f] = await db
      .select()
      .from(read.findings)
      .where(eq(read.findings.id, ids['new_on_head']!));
    expect(f!.status).toBe('open');
  });

  it('a session cookie riding along does not lift a token request into a member one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: { authorization: `Bearer ${token}` },
      cookies: { repopulse_sid: adminCookie },
    });
    expect(res.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: { authorization: 'Bearer rpci_not-a-real-token' },
      cookies: { repopulse_sid: adminCookie },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('serves the CLI to the token, so a pipeline can fetch it', async () => {
    const res = await get('/api/v1/cli/repopulse.mjs', { token });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toContain('RepoPulse CI check');
  });

  it('records last use', async () => {
    const [row] = await db.select().from(core.ciTokens).where(eq(core.ciTokens.id, tokenId));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('an expired token is refused like an unknown one', async () => {
    const minted = mintCiToken();
    await db.insert(core.ciTokens).values({
      workspaceId,
      name: 'expired',
      tokenHash: minted.hash,
      tokenPrefix: minted.displayPrefix,
      repoIds: [repoA],
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await get(findingsUrl(repoA), { token: minted.token });
    expect(res.statusCode).toBe(401);
    expect((await get(findingsUrl(repoA), { token: 'garbage' })).statusCode).toBe(401);
  });

  it('revoking takes effect on the very next request, keeps the row, and is audited', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/ci-tokens/${tokenId}`,
      headers: XRW,
      cookies: { repopulse_sid: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await get(findingsUrl(repoA), { token })).statusCode).toBe(401);
    const [row] = await db.select().from(core.ciTokens).where(eq(core.ciTokens.id, tokenId));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedBy).toBe(userIds[0]);
    expect(log.raw()).toContain('"event":"ci_token.revoked"');
    // Revoking twice is a 404: there is no active token left to revoke.
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/ci-tokens/${tokenId}`,
      headers: XRW,
      cookies: { repopulse_sid: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });
});
