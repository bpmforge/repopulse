import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { registerBuiltinScanners } from '@repopulse/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import securityRoutes from './index.js';
import codeHealthRoutes from '../code-health/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// W17-20. Two wire facts the Security and Code Health tabs now rely on:
//
//   the Security payload carries the findings themselves (`top_findings`),
//   with real ids the tab links to — a count with no row behind it was how a
//   scan that found something looked identical to one that had not;
//
//   the Code Health payload speaks the SAME state vocabulary as Security. It
//   used to fold a scan_run still 'running' into 'ok', so the tab said
//   "✓ ran clean" for the whole of every scan.
//
// Own fixtures, own cleanup — the runs suite explains why (W16-10).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const WS_SLUG = 'w17-20-routes';
const USER_SUBJECT = 'w17-20-routes@example.com';

describeIfLiveInfra('security + code-health payloads (W17-20)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;
  let repoId = 0;
  let runningRunId = 0;
  let securityRunId = 0;
  let findingIds: number[] = [];

  beforeAll(async () => {
    registerBuiltinScanners();
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: WS_SLUG, name: 'W17-20 routes' })
      .onConflictDoNothing()
      .returning({ id: core.workspaces.id });
    workspaceId =
      ws?.id ??
      (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, WS_SLUG))
          .limit(1)
      )[0]!.id;

    const [u] = await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: USER_SUBJECT,
        login: 'w17-20',
        email: USER_SUBJECT,
      })
      .onConflictDoNothing()
      .returning({ id: core.users.id });
    userId =
      u?.id ??
      (
        await db
          .select({ id: core.users.id })
          .from(core.users)
          .where(eq(core.users.authSubject, USER_SUBJECT))
          .limit(1)
      )[0]!.id;

    const enc = credentials.encryptCredential('w17-20-fixture-token', Buffer.alloc(32, 7));
    const [c] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: userId,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = c!.id;

    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w17-20-routes-repo',
        org: 'w17-20',
        name: 'routes',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = r!.id;

    const [running] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'code_health_tools',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'running',
        startedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    runningRunId = running!.id;

    const [done] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    securityRunId = done!.id;

    const finding = (dimension: string, severity: number, title: string, i: number) => ({
      workspaceId,
      repoId,
      scanRunId: securityRunId,
      dimension,
      severity,
      confidence: 4,
      title,
      scannerKey: dimension === 'code_health' ? 'code_health_tools' : 'secrets',
      file: 'src/a.ts',
      lineStart: 10 + i,
      lineEnd: 12 + i,
      evidence: 'x',
      recommendation: 'y',
      tier: 2,
      dedupKey: `w17-20-${dimension}-${i}`,
      status: 'open',
    });
    const inserted = await db
      .insert(read.findings)
      .values([
        finding('security', 3, 'lesser security', 0),
        finding('security', 5, 'worst security', 1),
        finding('code_health', 5, 'not a security finding', 2),
      ])
      .returning({ id: read.findings.id });
    findingIds = inserted.map((row) => row.id);

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: WS_SLUG, name: 'W17-20 routes' };
      request.role = 'admin';
    });
    await app.register(securityRoutes, { db });
    await app.register(codeHealthRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (findingIds.length)
      await db.delete(read.findings).where(inArray(read.findings.id, findingIds));
    if (repoId) {
      await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
      await db.delete(core.repos).where(eq(core.repos.id, repoId));
    }
    if (connectionId)
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    if (userId) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, userId));
      await db.delete(core.users).where(eq(core.users.id, userId));
    }
    if (workspaceId) await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('the Security payload lists the findings themselves, worst first, security dimensions only', async () => {
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/security` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      top_findings: {
        id: number;
        title: string;
        severity: number;
        dimension: string;
        line: number | null;
      }[];
      scanners: { key: string; state: string; open_findings: number }[];
    };
    expect(body.top_findings.map((f) => f.title)).toEqual(['worst security', 'lesser security']);
    // Real ids — the tab links to /findings?finding=<id> with these.
    expect(body.top_findings.map((f) => f.id).sort()).toEqual(findingIds.slice(0, 2).sort());
    expect(body.top_findings[0]).toMatchObject({ dimension: 'security', line: 11 });
    // The run that produced them is ok with findings open, not "ran clean".
    expect(body.scanners.find((s) => s.key === 'secrets')).toMatchObject({
      state: 'ok',
      open_findings: 2,
    });
  });

  it('the Code Health payload reports a scan in flight as running, not ok', async () => {
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/code-health` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanners: { key: string; state: string }[] };
    expect(body.scanners.find((s) => s.key === 'code_health_tools')?.state).toBe('running');
    // The two scanners with no run at all keep never_run, as before.
    expect(body.scanners.find((s) => s.key === 'anti_slop')?.state).toBe('never_run');
  });

  it('…and as ok once the same run succeeds', async () => {
    await db
      .update(security.scanRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runningRunId));
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/code-health` });
    const body = res.json() as {
      scanners: { key: string; state: string; open_findings: number }[];
    };
    expect(body.scanners.find((s) => s.key === 'code_health_tools')).toMatchObject({
      state: 'ok',
      open_findings: 1,
    });
  });
});
