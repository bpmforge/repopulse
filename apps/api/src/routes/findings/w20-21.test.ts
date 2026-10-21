import 'dotenv/config';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { reopenDueAcceptedRisks } from '@repopulse/insights';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import findingsRoutes, { listFilters, reviewByFrom, rotatedOnFrom } from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import { cveRows, fixedIn } from '../security/index.js';
import { nextCronRun, scannerRuns, scheduledScanners } from '../../lib/scan-schedule.js';

// W20-21 (UX_TODO FND-22/25/28/51/52/55/61/68, AI-32): review dates for
// accepted risk, "rotated" for secrets, link filters for one scan run, one AI
// pass and an explicit id list, the CVE table's fix versions and when each
// scanner runs on its own.

const dialect = new PgDialect();
const offline: Database = createDb('postgres://nobody@127.0.0.1:1/none');
const render = (q: Record<string, string>) => {
  // A real query builder (subqueries need one); postgres-js connects lazily, never here.
  const { filters } = listFilters(offline, 1, q);
  return dialect.sqlToQuery(and(...filters)!);
};

describe('review date for accepted risk (FND-25)', () => {
  const today = new Date('2026-10-21T12:00:00Z');
  it('takes a date after today and within two years', () => {
    expect(reviewByFrom('2027-01-31', today)).toEqual({ date: '2027-01-31' });
  });
  it('refuses a missing, past, today, impossible or far date', () => {
    expect(reviewByFrom(undefined, today)).toHaveProperty('refusal');
    expect(reviewByFrom('2026-10-21', today)).toHaveProperty('refusal');
    expect(reviewByFrom('2026-02-30', today)).toHaveProperty('refusal');
    expect(reviewByFrom('2029-01-01', today)).toHaveProperty('refusal');
  });
});

describe('rotation date (FND-61)', () => {
  const today = new Date('2026-10-21T12:00:00Z');
  const firstSeen = new Date('2026-09-01T00:00:00Z');
  it('takes today or earlier', () => {
    expect(rotatedOnFrom('2026-10-21', firstSeen, today)).toEqual({ date: '2026-10-21' });
  });
  it('refuses the future and a date years before the leak was seen', () => {
    expect(rotatedOnFrom('2026-10-22', firstSeen, today)).toHaveProperty('refusal');
    expect(rotatedOnFrom('2020-01-01', firstSeen, today)).toHaveProperty('refusal');
  });
});

describe('link filters (FND-22, FND-55, FND-68, AI-32)', () => {
  it('narrows to an explicit id list, dropping junk', () => {
    const q = render({ ids: '3,x,4,3' });
    expect(q.sql).toMatch(/"id" in \(\$\d+, \$\d+\)/);
    expect(q.params).toEqual(expect.arrayContaining([3, 4]));
  });
  it('narrows to what one scan run raised, and what it closed', () => {
    expect(render({ scan_run_id: '9' }).sql).toMatch(/"scan_run_id" in/);
    const closed = render({ closed_by_scan_run: '9' });
    expect(closed.sql).toMatch(/"finding_events"/);
    expect(closed.sql).toMatch(/"to_status" = \$/);
    // The subquery is tenant-filtered too.
    expect(closed.sql.match(/"workspace_id" = \$/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it('narrows to one AI pass, or to anything a model raised', () => {
    expect(render({ ai_pass_run_id: '5' }).sql).toMatch(/"ai_finding_provenance"/);
    expect(render({ found_by: 'model' }).sql).toMatch(/"analysis_run_id" is not null/);
  });
  it('covers every security dimension and one exact severity', () => {
    const q = render({ dimension_group: 'security', severity: '5' });
    expect(q.params).toEqual(expect.arrayContaining(['secrets', 'dependency', 'sast', 5]));
    expect(q.sql).toMatch(/"severity" = \$/);
  });
});

describe('CVE rows carry the fix version (FND-28)', () => {
  const base = {
    dimension: 'dependency',
    severity: 3,
    scannerKey: 'dependency_cve',
    ruleId: null,
    experimental: false,
  };
  it('reads the scanner list first, then the recommendation sentence', () => {
    const rows = cveRows([
      {
        ...base,
        id: 1,
        title: 'CVE-1 in a 1.0',
        cveId: 'CVE-1',
        yields: { fixed_in: ['1.2.3', '1.2.3', '2.0.0'] },
      },
      {
        ...base,
        id: 2,
        title: 'CVE-2 in b 1.0',
        cveId: 'CVE-2',
        yields: null,
        recommendation: 'Upgrade to 4.17.21. See the advisory.',
      },
      { ...base, id: 3, title: 'CVE-3 in c 1.0', cveId: 'CVE-3', yields: null },
    ]);
    expect(rows.map((r) => r.fixed_in)).toEqual([['1.2.3', '2.0.0'], ['4.17.21'], []]);
  });
  it('is empty when nothing names a fix', () => {
    expect(fixedIn({ fixed_in: [] }, 'No fix is published yet.')).toEqual([]);
  });
});

describe('when scanners run (FND-52)', () => {
  // Local time throughout: the worker's cron runs in the server's zone.
  const wed = new Date(2026, 9, 21, 12, 0); // Wed 21 Oct 2026, 12:00
  it('finds the next fire of weekly, nightly and monthly lines', () => {
    expect(nextCronRun('41 2 * * 0', wed)).toEqual(new Date(2026, 9, 25, 2, 41));
    expect(nextCronRun('17 3 * * *', wed)).toEqual(new Date(2026, 9, 22, 3, 17));
    expect(nextCronRun('23 4 1 * *', wed)).toEqual(new Date(2026, 10, 1, 4, 23));
    expect(nextCronRun('*/5 * * * *', wed)).toBeNull();
  });
  it('says per scanner: on every change, on a schedule, or only by hand', () => {
    const env = {} as NodeJS.ProcessEnv;
    const secrets = scannerRuns('secrets', ['pr_synced', 'push', 'schedule', 'manual'], env, wed);
    expect(secrets.on_change).toBe(true);
    expect(secrets.text).toMatch(
      /^on every pull request and push; history sweep monthly, next Sun 1 Nov 04:23/,
    );
    const semgrep = scannerRuns('semgrep', ['schedule', 'manual'], env, wed);
    expect(semgrep).toMatchObject({ cadence: 'weekly', cron: '41 2 * * 0', manual: true });
    expect(semgrep.text).toMatch(/^weekly, next Sun 25 Oct 02:41 \(server time\); or by hand$/);
    expect(scannerRuns('logging_hygiene', ['schedule', 'manual'], env, wed).cron).toBe(
      '41 2 * * 0',
    );
    expect(scannerRuns('container_image', ['manual'], env, wed).text).toBe(
      'only when started by hand',
    );
  });
  it('matches the repeatable jobs the worker registers', () => {
    const src = readFileSync(new URL('../../workers/index.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("['semgrep', weeklyCron]"), src.indexOf('] as const) {'));
    const worker = [...block.matchAll(/\['(\w+)', (\w+)Cron\]/g)].map((m) => [m[1], m[2]]);
    const word = { weekly: '41 2 * * 0', chain: '41 3 * * 0', registers: '17 3 * * *' } as const;
    expect(worker.map(([k, c]) => [k, word[c as keyof typeof word]])).toEqual(
      scheduledScanners({} as NodeJS.ProcessEnv),
    );
  });
  it('lists no schedule when the weekly pass is switched off', () => {
    expect(scheduledScanners({ SECURITY_WEEKLY_CRON: 'off' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      scannerRuns('semgrep', ['schedule', 'manual'], {
        SECURITY_WEEKLY_CRON: 'off',
      } as NodeJS.ProcessEnv).text,
    ).toBe('only when started by hand');
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('accepted risk review and rotated secrets (routes)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  const logs: string[] = [];
  let WS = 0;
  let USER = 0;
  let repoId = 0;
  let connectionId = 0;
  let scanRunId = 0;

  async function finding(dimension: string, title: string) {
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: WS,
        repoId,
        scanRunId,
        dimension,
        tier: 1,
        severity: 3,
        confidence: 4,
        title,
        file: 'src/a.ts',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'e',
        recommendation: 'r',
        scannerKey: dimension === 'secrets' ? 'secrets' : 'semgrep',
        dedupKey: `w20-21-${title}-${Math.random().toString(36).slice(2)}`,
        status: 'open',
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }

  beforeAll(async () => {
    await db
      .insert(core.workspaces)
      .values({ slug: 'w20-21-findings', name: 'w20-21' })
      .onConflictDoNothing();
    WS = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w20-21-findings'))
    )[0]!.id;
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w20-21@example.test',
        login: 'rotating-rita',
        email: 'w20-21@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w20-21@example.test'))
    )[0]!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: WS,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `w20-21-${Math.random().toString(36).slice(2)}`,
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: WS,
        connectionId,
        forgeRepoId: `w20-21-${Math.random().toString(36).slice(2)}`,
        org: 'w20-21',
        name: 'api',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = repo!.id;
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: WS,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'abc1234def',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    scanRunId = sr!.id;

    app = Fastify({
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } },
    });
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: WS, slug: 't', name: 't' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k) => (k === 'userId' ? USER : undefined),
      };
    });
    await app.register(findingsRoutes, { db });
    await app.ready();
  });
  afterAll(async () => {
    const ids = (
      await db
        .select({ id: read.findings.id })
        .from(read.findings)
        .where(eq(read.findings.repoId, repoId))
    ).map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(read.findingEvents).where(inArray(read.findingEvents.findingId, ids));
      await db.delete(read.findings).where(inArray(read.findings.id, ids));
    }
    await db.delete(security.scanRuns).where(eq(security.scanRuns.id, scanRunId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await app?.close();
    await db.$client.end();
  });
  beforeEach(() => {
    logs.length = 0;
  });

  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it('accepted risk needs a review date, stores it, and the nightly pass reopens it when due', async () => {
    const id = await finding('security', 'accepted one');
    const refused = await app.inject({
      method: 'PATCH',
      url: `/findings/${id}`,
      payload: { status: 'dismissed', dismiss_reason: 'accepted_risk', note: 'team accepts it' },
    });
    expect(refused.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/findings/${id}`,
      payload: {
        status: 'dismissed',
        dismiss_reason: 'accepted_risk',
        note: 'team accepts it',
        review_by: tomorrow(),
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ review_by: tomorrow() });

    // Not due today; due the day after.
    expect(await reopenDueAcceptedRisks(db, WS, new Date())).not.toContain(id);
    const due = await reopenDueAcceptedRisks(db, WS, new Date(Date.now() + 2 * 86_400_000));
    expect(due).toContain(id);
    const [row] = await db
      .select({ status: read.findings.status, reviewBy: read.findings.reviewBy })
      .from(read.findings)
      .where(eq(read.findings.id, id));
    expect(row).toEqual({ status: 'open', reviewBy: null });
  });

  it('records a secret as rotated, which resolves it; other findings are refused', async () => {
    const secret = await finding('secrets', 'aws key');
    const other = await finding('security', 'not a secret');
    const today = new Date().toISOString().slice(0, 10);

    const wrong = await app.inject({
      method: 'POST',
      url: `/findings/${other}/rotated`,
      payload: { rotated_on: today, note: 'rotated the key at the issuer' },
    });
    expect(wrong.statusCode).toBe(409);

    const short = await app.inject({
      method: 'POST',
      url: `/findings/${secret}/rotated`,
      payload: { rotated_on: today, note: 'done' },
    });
    expect(short.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/findings/${secret}/rotated`,
      payload: { rotated_on: today, note: 'rotated the key at the issuer' },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await db
      .select({ status: read.findings.status, reason: read.findings.dismissReason })
      .from(read.findings)
      .where(eq(read.findings.id, secret));
    expect(row).toEqual({ status: 'resolved', reason: 'rotated' });
    expect(logs.some((l) => l.includes('finding.secret_rotated'))).toBe(true);

    // The history names the scan a finding was last seen by.
    const history = await app.inject({ method: 'GET', url: `/findings/${secret}/history` });
    expect(history.statusCode).toBe(200);
  });

  it('lists exactly the ids asked for ("Show these")', async () => {
    const a = await finding('security', 'first of two');
    await finding('security', 'second of two');
    const res = await app.inject({ method: 'GET', url: `/findings?ids=${a}&status=any` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: { id: number }[] }).items.map((f) => f.id)).toEqual([a]);
  });
});
