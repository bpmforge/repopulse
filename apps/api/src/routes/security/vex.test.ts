import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import {
  CYCLONEDX_SCHEMA,
  OPENVEX_SCHEMA,
  schemaRegistry,
  validateAgainstSchema,
} from '@repopulse/security';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';
import { purlOfFinding, versionFromEvidence } from './vex.js';

// VEX triage and export, end to end (W8-14, FR-SEC-14/15).
//
// AGAINST A REAL POSTGRES, deliberately. Two of the three gates on an
// unjustified dismissal live in the database — the CHECK constraint and the
// unique key that makes a re-triage an amendment — and a stubbed db would test
// the route's opinion of them rather than the constraints themselves.
//
// The SBOM this file stores is the REAL syft capture from fixtures/vex, so the
// embedded-VEX export is validated against a component list a tool produced
// rather than one written to make the assertions pass.

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/security/fixtures/vex',
);

describe('reading a package identity off a finding', () => {
  it('parses the purl and version the dependency scanner writes', () => {
    // The documented coupling to scanners/dependency/findings.ts: the evidence
    // quote is `<purl> is affected by <id>`, and it is the only place a finding
    // row carries a structured package identity.
    const evidence = 'pkg:npm/jquery@3.3.1 is affected by CVE-2020-11022';
    expect(purlOfFinding(evidence)).toBe('pkg:npm/jquery');
    expect(versionFromEvidence(evidence)).toBe('3.3.1');
  });

  it('returns null rather than guessing at an evidence quote it cannot read', () => {
    // A statement attached to the wrong package is worse than a 400.
    expect(purlOfFinding('something else entirely')).toBeNull();
    expect(versionFromEvidence('pkg:npm/jquery is affected by CVE-1')).toBeNull();
  });
});

describeIfLiveInfra('VEX routes (W8-14, FR-SEC-14)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let repoId: number;
  let connectionId: number;
  let scanRunId: number;
  let triagerUserId: number;
  let findingId: number;
  let secretFindingId: number;
  let cookie: string;

  const sbom = JSON.parse(
    readFileSync(path.join(FIXTURES, 'jquery-331-sbom.cyclonedx.json'), 'utf8'),
  ) as Record<string, unknown>;

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
      sessionSecret: 'w8-14-session-secret-that-is-long-enough-here',
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

    const [connUser] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w8-14-conn',
        forgeUserId: 'w8-14-conn',
        login: 'w8-14-conn',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-14-conn' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w8-14-fp',
        status: 'active',
        createdBy: connUser!.id,
      })
      .returning();
    connectionId = conn!.id;

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w8-14-repo',
        org: 'repopulse',
        name: 'w8-14-vex',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .onConflictDoUpdate({
        target: [core.repos.workspaceId, core.repos.connectionId, core.repos.forgeRepoId],
        set: { name: 'w8-14-vex' },
      })
      .returning();
    repoId = repo!.id;

    await db.insert(security.sboms).values({
      workspaceId,
      repoId,
      commitSha: 'w8-14-sha',
      format: 'cyclonedx',
      document: sbom,
      componentCount: 3,
      generatedBy: 'syft@1.51.0',
    });

    // findings_run_parent_check: a finding must name the run that produced it.
    // The scan_run also carries the validation funnel the Security tab reads.
    const [scanRun] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'dependency_cve',
        scannerVersion: 'syft@1.51.0 grype@0.117.0',
        commitSha: 'w8-14-sha',
        trigger: 'manual',
        status: 'succeeded',
        validationFunnel: { raw: 3, deduped: 3 },
      })
      .returning();
    scanRunId = scanRun!.id;

    const [dependency] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        dimension: 'dependency',
        tier: 1,
        severity: 4,
        confidence: 5,
        title: 'CVE-2020-11022 in jquery 3.3.1',
        file: 'package-lock.json',
        evidence: 'pkg:npm/jquery@3.3.1 is affected by CVE-2020-11022',
        recommendation: 'Upgrade to 3.5.0.',
        dedupKey: 'w8-14-dep-key',
        scanRunId,
        status: 'open',
        scannerKey: 'dependency_cve',
        ruleId: 'CVE-2020-11022',
        cveId: 'CVE-2020-11022',
        yields: {
          reachability: 'manifest_only',
          usage: 'not_imported',
          aliases: ['GHSA-gxr4-xjj5-5px2'],
        },
      })
      .returning();
    findingId = dependency!.id;

    const [secret] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        dimension: 'secrets',
        tier: 1,
        severity: 5,
        confidence: 5,
        title: 'AWS key',
        file: 'config.yml',
        evidence: 'AKIA…',
        recommendation: 'Rotate it.',
        dedupKey: 'w8-14-secret-key',
        scanRunId,
        status: 'open',
        scannerKey: 'secrets',
      })
      .returning();
    secretFindingId = secret!.id;

    // The triager has to be a MEMBER before logging in: `request.workspace` is
    // resolved from membership, and without a row here every call below is a
    // 401 that looks like a broken route rather than an absent fixture.
    const [triager] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w8-14-triager',
        forgeUserId: 'w8-14-triager',
        login: 'w8-14-triager',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-14-triager' } })
      .returning();
    triagerUserId = triager!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: triagerUserId, role: 'member' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'member' },
      });

    cookie = await loginAs(app, 'w8-14-triager');
  });

  afterAll(async () => {
    await db.delete(security.vexStatements).where(eq(security.vexStatements.repoId, repoId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.sboms).where(eq(security.sboms.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db
      .delete(core.workspaceMembers)
      .where(eq(core.workspaceMembers.userId, triagerUserId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  it('rejects not_affected with no justification — 400, and nothing is stored', async () => {
    // THE GATE THE WHOLE TICKET TURNS ON. "We looked and it does not apply"
    // must carry a reason a reader can disagree with.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { status: 'not_affected' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toMatch(/justification/i);

    const rows = await db
      .select()
      .from(security.vexStatements)
      .where(eq(security.vexStatements.repoId, repoId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a justification outside the OpenVEX enum', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { status: 'not_affected', justification: 'we_had_a_look' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a version range the grammar cannot read', async () => {
    // Refused at WRITE time, so a stored suppression whose meaning nobody can
    // reconstruct never exists.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: {
        status: 'not_affected',
        justification: 'vulnerable_code_not_in_execute_path',
        version_range: '^3.0.0',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/caret or tilde/);
  });

  it('refuses under_investigation, which is a withdrawal and not a statement', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { status: 'under_investigation' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to describe a finding that is not about a component', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${secretFindingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { status: 'not_affected', justification: 'component_not_present' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/dimension 'secrets'/);
  });

  it('records a justified not_affected and defaults the range to the observed version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: {
        status: 'not_affected',
        justification: 'vulnerable_code_not_in_execute_path',
        notes: 'Nothing in this repository imports jquery; it is a transitive of the docs build.',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.package_purl).toBe('pkg:npm/jquery');
    // The honest default: the triager looked at THIS version, and claiming more
    // on their behalf is how a suppression outlives its evidence.
    expect(body.version_range).toBe('3.3.1');

    const [row] = await db
      .select()
      .from(security.vexStatements)
      .where(
        and(eq(security.vexStatements.repoId, repoId), eq(security.vexStatements.id, body.id)),
      );
    expect(row!.justification).toBe('vulnerable_code_not_in_execute_path');
    // The evidence the triager was shown, captured so the decision can be
    // re-examined against it later rather than against next month's tiers.
    expect(row!.evidence['finding_id']).toBe(findingId);
    expect(row!.evidence['reachability']).toBe('manifest_only');
    expect(row!.authorUserId).toBeTypeOf('number');
  });

  it('treats a re-triage of the same range as an amendment, not a second opinion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/findings/${findingId}/vex`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: {
        status: 'not_affected',
        justification: 'inline_mitigations_already_exist',
        version_range: '3.3.1',
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = await db
      .select()
      .from(security.vexStatements)
      .where(eq(security.vexStatements.repoId, repoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.justification).toBe('inline_mitigations_already_exist');
  });

  it('the database refuses an unjustified dismissal even when the route is bypassed', async () => {
    // The second gate. A route check binds only the writer that runs it; a
    // migration, a fixture loader or tomorrow's second endpoint would all be
    // free to insert an unjustified dismissal without this. drizzle (0.44+)
    // wraps the driver error, so the constraint is read off `cause`.
    await expect(
      db.insert(security.vexStatements).values({
        workspaceId,
        repoId,
        packagePurl: 'pkg:npm/left-pad',
        vulnId: 'CVE-9999-0001',
        versionRange: '*',
        status: 'not_affected',
        justification: null,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'vex_statements_justification_required_check' },
    });
  });

  it('exports OpenVEX that validates against the published schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/vex.json`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const document = res.json() as Record<string, unknown>;
    expect(validateAgainstSchema(schemaRegistry(), OPENVEX_SCHEMA, document)).toEqual([]);
    expect((document['statements'] as unknown[]).length).toBe(1);
  });

  it('exports a CycloneDX SBOM with embedded VEX that validates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/sbom?vex=1`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const document = res.json() as Record<string, unknown>;
    expect(validateAgainstSchema(schemaRegistry(), CYCLONEDX_SCHEMA, document)).toEqual([]);
    expect((document['vulnerabilities'] as unknown[]).length).toBe(1);
    // Statements dropped for want of a matching component are counted, never
    // silently lost.
    expect(res.headers['x-repopulse-vex-unmatched']).toBe('0');
  });

  it('serves the plain SBOM without VEX when nobody asked for it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/sbom`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()['vulnerabilities']).toBeUndefined();
  });

  it('exports a NOTICE-style attribution grouped by license', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/attribution`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.body).toContain('third-party notices');
  });

  it('every VEX endpoint needs a session', async () => {
    for (const url of [
      `/api/v1/repos/${repoId}/vex`,
      `/api/v1/repos/${repoId}/vex.json`,
      `/api/v1/repos/${repoId}/sbom`,
      `/api/v1/repos/${repoId}/attribution`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('withdrawing a statement removes it, so the next scan reports the finding again', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/vex`,
      cookies: { repopulse_sid: cookie },
    });
    const statementId = list.json().statements[0].id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoId}/vex/${statementId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    expect(res.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(security.vexStatements)
      .where(eq(security.vexStatements.repoId, repoId));
    // There is no un-suppress to run: nothing covers the finding any more, so
    // the next scan files it. That IS the mechanism.
    expect(rows).toHaveLength(0);
  });
});
