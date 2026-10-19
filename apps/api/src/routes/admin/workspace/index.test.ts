import 'dotenv/config';
import { Writable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, read, createDb, type Database } from '@repopulse/shared';
import { DEFAULT_BOT_LOGIN_GLOBS } from '@repopulse/metrics';
import { DEFAULT_WEIGHTS } from '@repopulse/insights';
import { buildApp } from '../../../app.js';
import { loginAs } from '../../../testing/login.js';

// SC-7: non-safe methods need this header or an onRequest hook 403s first.
const CSRF = { 'x-requested-with': 'repopulse' };

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Workspace settings (W4-09, FR-AUTH-4 / FR-INSIGHTS-2 / FR-METRICS-8).
//
// The acceptance criterion worth the setup cost is the LAST one: a changed
// weight must reach the health-score breakdown endpoint. buildHealthSubScores
// looks weights up by key with a `?? DEFAULT_WEIGHTS.<key>` fallback, so a
// wiring mistake or a renamed key does not fail — it silently scores exactly as
// before. Only reading the endpoint's own numbers can tell the difference.

describeIfLiveInfra('admin workspace settings (W4-09)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let memberUserId: number;
  let repoId: number;
  let connectionId: number;

  // Audit lines are captured at the DESTINATION, not by stubbing a method:
  // handlers log through `request.log`, which is a pino CHILD logger with its
  // own `info`, so replacing `app.log.info` intercepts nothing. Everything a
  // child writes still lands in the parent's stream.
  const logLines: Record<string, unknown>[] = [];
  const logSink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          try {
            logLines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* non-JSON line (nothing in this app writes one) */
          }
        }
      }
      cb();
    },
  });

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
      sessionSecret: 'w4-09-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
      loggerInstance: pino({ level: 'info' }, logSink),
    });
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    // Start from a known state: another suite's leftovers would make the
    // "unset means defaults" assertions pass or fail for the wrong reason.
    await db
      .update(core.workspaces)
      .set({ settings: {} })
      .where(eq(core.workspaces.id, workspaceId));

    const [member] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w4-09-member',
        forgeUserId: 'w4-09-member',
        login: 'w4-09-member',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w4-09-member' } })
      .returning();
    memberUserId = member!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: memberUserId, role: 'member' })
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
        credentialCiphertext: Buffer.alloc(8),
        credentialIv: Buffer.alloc(12),
        keyVersion: 1,
        credentialFingerprint: 'w4-09-fingerprint',
        status: 'active',
        createdBy: memberUserId,
      })
      .returning();
    connectionId = conn!.id;

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w4-09-repo',
        org: 'w4-09-org',
        name: 'weights',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // TWO sub-scores, deliberately. With one present, computeHealthScore
    // renormalizes its weight to 1.0 and every weight config produces the same
    // number — the test would pass against a completely unwired endpoint.
    // M5 feeds reviewHygiene (default .30), M9 feeds ciHealth (default .25).
    await db.insert(read.metricSnapshots).values([
      { workspaceId, repoId, metricKey: 'M5', window: '30d', value: '0.9', dims: {} },
      {
        workspaceId,
        repoId,
        metricKey: 'M9',
        window: '30d',
        // 0.8 sits BETWEEN ramp(0.95, 0.6)'s good and bad, so ciHealth
        // normalizes to something non-zero. At 0.5 it clamps to 0, every
        // contribution is 0 × weight, and the contribution assertion below
        // compares equal no matter what the weights are.
        value: '0.8',
        dims: { passRate: 0.8 },
      },
    ]);
  });

  afterAll(async () => {
    // Cleaned by FIXTURE MARKER, not by the ids this run happened to create: a
    // run that dies mid-suite leaves rows behind, and the next run's `delete
    // users` then fails on their foreign key — which presents as a suite that
    // passes every test and still reports failed.
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.forgeRepoId, 'w4-09-repo'));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, 'w4-09-fingerprint'));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, memberUserId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w4-09-member'));
    // The admin fixture MUST go too. Suites share the `default` workspace, and
    // W4-20 asserts the API refuses to demote the LAST admin — a leftover
    // second admin from this suite makes that demotion legal and fails a test
    // in a file this one never touches.
    const [adminUser] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w4-09-admin'));
    if (adminUser) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, adminUser.id));
      await db.delete(core.users).where(eq(core.users.id, adminUser.id));
    }
    await db
      .update(core.workspaces)
      .set({ settings: {} })
      .where(eq(core.workspaces.id, workspaceId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
    await db.$client.end();
  });

  // Cached deliberately: SC-11 rate-limits auth to 10/min, and one login per
  // test is how W12-07's intermittently-red unit gate happened.
  let adminCookie: string | undefined;

  async function adminSession(): Promise<string> {
    if (adminCookie) return adminCookie;
    const cookie = await loginAs(app, 'w4-09-admin');
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w4-09-admin'));
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: u!.id, role: 'admin' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'admin' },
      });
    adminCookie = cookie;
    return cookie;
  }

  function get(cookie: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/admin/workspace',
      cookies: { repopulse_sid: cookie },
    });
  }

  function patch(cookie: string, payload: unknown) {
    return app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/workspace',
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: payload as object,
    });
  }

  it('reports the METRICS.md defaults, and reports them AS defaults', async () => {
    const res = await get(await adminSession());
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stored: Record<string, unknown>;
      effective: { botLoginGlobs: string[]; healthWeights: Record<string, number> };
      defaults: { stalePrDays: number };
      pending: string[];
    };
    // `stored` empty while `effective` is populated is what lets the screen say
    // "default" instead of showing a number an admin never chose.
    expect(body.stored).toEqual({});
    expect(body.effective.botLoginGlobs).toEqual([...DEFAULT_BOT_LOGIN_GLOBS]);
    expect(body.effective.healthWeights).toEqual(DEFAULT_WEIGHTS);
    expect(body.defaults.stalePrDays).toBe(7);
    // The LLM knobs are named by the API rather than hardcoded in the UI, so
    // the screen cannot disagree with the server about what is not ready yet.
    expect(body.pending).toContain('tier3_monthly_usd_cap');
  });

  it('a member cannot read or write workspace settings (FR-AUTH-4)', async () => {
    const cookie = await loginAs(app, 'w4-09-member');
    expect((await get(cookie)).statusCode).toBe(403);
    expect((await patch(cookie, { stale_pr_days: 30 })).statusCode).toBe(403);
  });

  it('rejects weights that do not sum to 1.00, naming the field', async () => {
    const res = await patch(await adminSession(), {
      health_weights: { activity: 0.9, reviewHygiene: 0.9, ciHealth: 0.9, delivery: 0.9 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { detail?: string }).detail).toContain('health_weights');
  });

  it('PATCH merges — saving one key does not erase another', async () => {
    const cookie = await adminSession();
    await patch(cookie, { stale_pr_days: 21 });
    await patch(cookie, { bot_login_globs: ['ci-bot*'] });
    const body = (await get(cookie)).json() as { stored: Record<string, unknown> };
    // A `.set({ settings: body })` would have dropped stale_pr_days here — and
    // would drop the W6/W7 LLM settings the same way once they exist.
    expect(body.stored.stale_pr_days).toBe(21);
    expect(body.stored.bot_login_globs).toEqual(['ci-bot*']);
  });

  it('an emptied bot list is stored as empty, not as unset', async () => {
    const cookie = await adminSession();
    await patch(cookie, { bot_login_globs: [] });
    const body = (await get(cookie)).json() as {
      stored: { bot_login_globs?: string[] };
      effective: { botLoginGlobs: string[] };
    };
    expect(body.stored.bot_login_globs).toEqual([]);
    expect(body.effective.botLoginGlobs).toEqual([]);
  });

  it('a weight change moves the health-score breakdown endpoint', async () => {
    const cookie = await adminSession();
    const readBreakdown = async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoId}?window=30d`,
        cookies: { repopulse_sid: cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        health: { breakdown: { key: string; weight: number; contribution: number }[] };
      };
      return new Map(body.health.breakdown.map((s) => [s.key, s]));
    };

    // Defaults: reviewHygiene .30 and ciHealth .25 are the only sub-scores with
    // inputs, so they renormalize to .545 / .455.
    const before = await readBreakdown();
    expect(before.get('reviewHygiene')!.weight).toBeCloseTo(0.3 / 0.55, 6);
    expect(before.get('ciHealth')!.weight).toBeCloseTo(0.25 / 0.55, 6);

    await patch(cookie, {
      health_weights: { activity: 0.1, reviewHygiene: 0.1, ciHealth: 0.7, delivery: 0.1 },
    });

    const after = await readBreakdown();
    expect(after.get('reviewHygiene')!.weight).toBeCloseTo(0.1 / 0.8, 6);
    expect(after.get('ciHealth')!.weight).toBeCloseTo(0.7 / 0.8, 6);
    // The sub-scores themselves did not move — only what they are worth. If
    // this failed while the weights above passed, the weights would be reaching
    // presentation without reaching the arithmetic.
    expect(after.get('ciHealth')!.contribution).toBeGreaterThan(
      before.get('ciHealth')!.contribution,
    );
  });

  it('records an SC-22 audit entry naming the changed keys, and no values', async () => {
    const cookie = await adminSession();
    const before = logLines.length;
    await patch(cookie, { stale_pr_days: 14 });

    const entry = logLines
      .slice(before)
      .find((l) => l.audit === true && l.event === 'workspace.settings.updated');
    expect(entry).toBeDefined();
    expect(entry!.changedKeys).toEqual(['stale_pr_days']);
    expect(entry!.workspaceId).toBe(workspaceId);
    // The VALUES are deliberately absent: the LM host list lands in this same
    // object in W6 and an audit stream is not where a credential should
    // surface. Asserted over the entry's own fields rather than a substring of
    // the serialised line — pino stamps `time` and `pid`, and any short value
    // appears inside one of those by coincidence, which would make a substring
    // check fail on a correct entry (it did).
    expect(Object.values(entry!)).not.toContain(14);
  });
  // W18-20: the AI-authorship pattern list, and the org endpoint that applies it.
  it('stores an edited AI pattern list and reports it as effective; rejects unknown keys', async () => {
    const cookie = await adminSession();
    const ok = await patch(cookie, {
      ai_authorship_patterns: {
        trailer_patterns: ['noreply@anthropic.com'],
        bot_logins: ['acme-agent[bot]'],
        branch_prefixes: [],
      },
    });
    expect(ok.statusCode).toBe(200);
    const body = (await get(cookie)).json() as {
      effective: { aiAuthorshipPatterns: Record<string, string[]> };
      defaults: { aiAuthorshipPatterns: { branchPrefixes: string[] } };
    };
    expect(body.effective.aiAuthorshipPatterns).toEqual({
      trailerPatterns: ['noreply@anthropic.com'],
      botLogins: ['acme-agent[bot]'],
      branchPrefixes: [],
    });
    expect(body.defaults.aiAuthorshipPatterns.branchPrefixes).toContain('claude/');

    const bad = await patch(cookie, { ai_authorship_patterns: { regexes: ['.*'] } });
    expect(bad.statusCode).toBe(400);
  });

  // W20-08 (UX_TODO FND-18): the license policy was not in the schema, so it
  // could not be set and any other save stripped it.
  it('stores a license policy, reports what the register applies, and keeps it across other saves', async () => {
    const cookie = await adminSession();
    const before = (await get(cookie)).json() as {
      effective: { licensePolicy: { flagCategories: string[]; flagUnknown: boolean } };
    };
    expect(before.effective.licensePolicy.flagUnknown).toBe(true);

    const ok = await patch(cookie, {
      license_policy: {
        flag_categories: ['weak-copyleft'],
        flag_unknown: false,
        allow: ['MPL-2.0'],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect((await patch(cookie, { stale_pr_days: 9 })).statusCode).toBe(200);
    const body = (await get(cookie)).json() as {
      stored: { license_policy?: unknown };
      effective: {
        licensePolicy: {
          flagCategories: string[];
          flagUnknown: boolean;
          allow: string[];
          flag: string[];
        };
      };
    };
    expect(body.stored.license_policy).toBeDefined();
    expect(body.effective.licensePolicy).toMatchObject({
      flagCategories: ['weak-copyleft'],
      flagUnknown: false,
      allow: ['MPL-2.0'],
    });
    expect(body.effective.licensePolicy.flag).toContain('AGPL-3.0');

    const bad = await patch(cookie, { license_policy: { flag_categories: ['viral'] } });
    expect(bad.statusCode).toBe(400);
  });

  // W20-14: a hand-written legacy `licensePolicy` (camel case) and keys the
  // schema does not own were stripped by the next unrelated save.
  it('migrates a legacy licensePolicy and keeps unknown keys across an unrelated save', async () => {
    const cookie = await adminSession();
    await db
      .update(core.workspaces)
      .set({
        settings: {
          licensePolicy: { flagCategories: ['strong-copyleft'], flagUnknown: false, flag: ['X-1'] },
          lm_hosts: ['http://lm.local:1234'],
        },
      })
      .where(eq(core.workspaces.id, workspaceId));

    // Read path: the legacy policy shows as stored (not "default") before any save.
    const before = (await get(cookie)).json() as {
      stored: { license_policy?: unknown };
      effective: { licensePolicy: { flagCategories: string[]; flagUnknown: boolean } };
    };
    expect(before.stored.license_policy).toEqual({
      flag_categories: ['strong-copyleft'],
      flag_unknown: false,
      flag: ['X-1'],
    });
    expect(before.effective.licensePolicy.flagCategories).toEqual(['strong-copyleft']);

    expect((await patch(cookie, { stale_pr_days: 11 })).statusCode).toBe(200);

    const [row] = await db
      .select({ settings: core.workspaces.settings })
      .from(core.workspaces)
      .where(eq(core.workspaces.id, workspaceId));
    const saved = row!.settings as Record<string, unknown>;
    expect(saved['licensePolicy']).toBeUndefined();
    expect(saved['license_policy']).toEqual({
      flag_categories: ['strong-copyleft'],
      flag_unknown: false,
      flag: ['X-1'],
    });
    expect(saved['lm_hosts']).toEqual(['http://lm.local:1234']);
    expect(saved['stale_pr_days']).toBe(11);

    const after = (await get(cookie)).json() as {
      effective: { licensePolicy: { flagUnknown: boolean; flag: string[] } };
    };
    expect(after.effective.licensePolicy.flagUnknown).toBe(false);
    expect(after.effective.licensePolicy.flag).toEqual(['X-1']);

    await db
      .update(core.workspaces)
      .set({ settings: {} })
      .where(eq(core.workspaces.id, workspaceId));
  });

  it('GET /org/ai-governance is aggregate-only and validates its repo filter', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'GET',
      // `person` is the global filter's per-developer key; the endpoint must
      // not narrow to one person, so it is ignored rather than honoured.
      url: '/api/v1/org/ai-governance?window=90d&person=someone',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { window: string; measures: unknown[]; counts: object };
    expect(body.window).toBe('90d');
    expect(body.measures).toHaveLength(5);
    expect(JSON.stringify(body)).not.toContain('someone');

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/org/ai-governance?repos=1;drop',
      cookies: { repopulse_sid: cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
