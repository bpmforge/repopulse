import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import findingsRoutes from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import {
  EXPORT_CAP,
  cleanTicketUrl,
  csvCell,
  findingsCsv,
  findingsSarif,
  type ExportRow,
} from './export.js';

// W20-18 (UX_TODO X-08; decision 2026-10-20): the findings list as CSV or SARIF
// under its current filters, and an optional link to the ticket that tracks a
// finding in another tool.

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: 7,
  org: 'acme',
  repoName: 'api',
  title: 'SQL built from input',
  dimension: 'sast',
  severity: 4,
  confidence: 4,
  status: 'open',
  dismissReason: null,
  file: 'src/db.ts',
  lineStart: 10,
  lineEnd: 12,
  ruleId: 'sql.concat',
  scannerKey: 'semgrep',
  cveId: null,
  riskBand: 'high',
  effectiveRisk: '22.50',
  firstSeenAt: new Date('2026-10-01T00:00:00Z'),
  lastSeenAt: new Date('2026-10-02T00:00:00Z'),
  recommendation: 'Use a parameter.',
  externalTicketUrl: null,
  ...over,
});

describe('csvCell', () => {
  it('quotes what must be quoted and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
  });
});

describe('findingsCsv', () => {
  it('writes a header, one line per finding, and says so when cut', () => {
    const csv = findingsCsv([row({ externalTicketUrl: 'https://t.example/1' })], {
      base: 'https://pulse.example/',
      truncated: true,
    });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^id,repository,title,severity/);
    expect(lines[1]).toContain('acme/api,SQL built from input,high,4,sast,open');
    expect(lines[1]).toContain('https://t.example/1,https://pulse.example/findings?finding=7');
    expect(lines[2]).toMatch(new RegExp(`Cut at ${EXPORT_CAP} findings`));
  });
});

describe('findingsSarif', () => {
  it('is SARIF 2.1.0, one run per repository, with levels and suppressions', () => {
    const sarif = findingsSarif(
      [
        row(),
        row({ id: 8, severity: 2, status: 'dismissed', dismissReason: 'false_positive' }),
        row({ id: 9, repoName: 'web', ruleId: null, file: null }),
      ],
      { base: null, truncated: false },
    ) as {
      version: string;
      runs: { results: Record<string, unknown>[]; automationDetails: { id: string } }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs.map((r) => r.automationDetails.id)).toEqual([
      'repopulse/acme/api/',
      'repopulse/acme/web/',
    ]);
    const [first, dismissed] = sarif.runs[0]!.results;
    expect(first).toMatchObject({
      ruleId: 'sql.concat',
      level: 'error',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/db.ts' },
            region: { startLine: 10, endLine: 12 },
          },
        },
      ],
    });
    expect(dismissed).toMatchObject({
      level: 'note',
      suppressions: [{ kind: 'external', status: 'accepted' }],
    });
    const noFile = sarif.runs[1]!.results[0]!;
    expect(noFile.ruleId).toBe('repopulse/semgrep');
    expect(noFile.locations).toBeUndefined();
  });

  it('an empty export is still a valid log', () => {
    const sarif = findingsSarif([], { base: null, truncated: false }) as { runs: unknown[] };
    expect(sarif.runs).toHaveLength(1);
  });
});

describe('cleanTicketUrl', () => {
  it('keeps http(s) links and clears on null or blank', () => {
    expect(cleanTicketUrl('https://linear.app/acme/issue/ACM-1')).toEqual({
      url: 'https://linear.app/acme/issue/ACM-1',
    });
    expect(cleanTicketUrl('HTTPS://jira.example/browse/X-1')).toEqual({
      url: 'https://jira.example/browse/X-1',
    });
    expect(cleanTicketUrl(null)).toEqual({ url: null });
    expect(cleanTicketUrl('  ')).toEqual({ url: null });
  });

  it('refuses anything that is not a plain web link', () => {
    expect(cleanTicketUrl('javascript:alert(1)')).toMatch(/http and https/);
    expect(cleanTicketUrl('ftp://x.example/a')).toMatch(/http and https/);
    expect(cleanTicketUrl('https://user:pw@x.example/a')).toMatch(/user name or password/);
    expect(cleanTicketUrl('https://x.example/a b')).toMatch(/spaces/);
    expect(cleanTicketUrl('jira/X-1')).toMatch(/full link/);
    expect(cleanTicketUrl(`https://x.example/${'a'.repeat(2048)}`)).toMatch(/2048/);
    expect(cleanTicketUrl(42)).toMatch(/text/);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };

describeIfLiveInfra('findings export and ticket links (routes)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  const logs: string[] = [];
  let WS = 0;
  let OTHER = 0;
  let USER = 0;
  let asWorkspace = 0;
  const repos: number[] = [];
  const connections: number[] = [];
  const scanRuns: number[] = [];

  async function ws(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }
  async function repoIn(workspaceId: number, name: string) {
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `w20-18-${name}-${Math.random().toString(36).slice(2)}`,
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: core.forgeConnections.id });
    connections.push(conn!.id);
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: `w20-18-${name}-${Math.random().toString(36).slice(2)}`,
        org: 'w20-18',
        name,
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repos.push(repo!.id);
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId: repo!.id,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    scanRuns.push(sr!.id);
    return { repoId: repo!.id, scanRunId: sr!.id };
  }
  async function finding(
    workspaceId: number,
    at: { repoId: number; scanRunId: number },
    title: string,
    severity: number,
  ) {
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId: at.repoId,
        scanRunId: at.scanRunId,
        dimension: 'security',
        tier: 1,
        severity,
        confidence: 4,
        title,
        file: 'src/a.ts',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'e',
        recommendation: 'r',
        scannerKey: 'semgrep',
        dedupKey: `w20-18-${title}-${Math.random().toString(36).slice(2)}`,
        status: 'open',
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }

  let mine: { repoId: number; scanRunId: number };
  let theirs: { repoId: number; scanRunId: number };
  let high = 0;
  let low = 0;
  let foreign = 0;

  beforeAll(async () => {
    WS = await ws('w20-18-findings');
    OTHER = await ws('w20-18-findings-other');
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w20-18-findings@example.test',
        login: 'triager-tess',
        email: 'w20-18-findings@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w20-18-findings@example.test'))
        .limit(1)
    )[0]!.id;
    mine = await repoIn(WS, 'mine');
    theirs = await repoIn(OTHER, 'theirs');
    high = await finding(WS, mine, '=cmd|calc', 4);
    low = await finding(WS, mine, 'low one', 2);
    foreign = await finding(OTHER, theirs, 'not yours', 4);
    asWorkspace = WS;

    app = Fastify({
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } },
    });
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: asWorkspace, slug: 't', name: 't' };
      request.role = 'member';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k) => (k === 'userId' ? USER : undefined),
      };
    });
    await app.register(findingsRoutes, { db });
    await app.ready();
  });
  afterAll(async () => {
    await db.delete(read.findings).where(inArray(read.findings.repoId, repos));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.id, scanRuns));
    await db.delete(core.repos).where(inArray(core.repos.id, repos));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, connections));
    await app?.close();
    await db.$client.end();
  });
  beforeEach(() => {
    logs.length = 0;
    asWorkspace = WS;
  });
  const audits = (event: string) =>
    logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);

  it('exports CSV under the current filters, from this workspace only, and audits it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/findings/export?format=csv&severity_min=4&repo_id=${mine.repoId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="repopulse-findings-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers['x-repopulse-count']).toBe('1');
    expect(res.headers['x-repopulse-truncated']).toBe('false');
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^${high},w20-18/mine,'=cmd\\|calc,high`));
    expect(res.body).not.toContain('low one');

    const all = await app.inject({ method: 'GET', url: '/findings/export?format=csv' });
    expect(all.body).not.toContain('not yours');
    expect(all.body).toContain('low one');

    const [audit] = audits('finding.bulk_export');
    expect(audit).toMatchObject({
      workspaceId: WS,
      actorUserId: USER,
      detail: { format: 'csv', count: 1, truncated: false, filters: { severity_min: '4' } },
    });
  });

  it('exports SARIF, and refuses an unknown format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/findings/export?format=sarif&repo_id=${mine.repoId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/sarif\+json/);
    const sarif = res.json() as { version: string; runs: { results: unknown[] }[] };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]!.results).toHaveLength(2);
    expect(
      (await app.inject({ method: 'GET', url: '/findings/export?format=xlsx' })).statusCode,
    ).toBe(400);
  });

  it('links a ticket, shows it on the finding, audits the change, and clears it', async () => {
    const put = (id: number, url: unknown) =>
      app.inject({
        method: 'PUT',
        url: `/findings/${id}/external-ticket`,
        headers: CSRF,
        payload: { url },
      });
    expect((await put(low, 'javascript:alert(1)')).statusCode).toBe(400);
    expect((await put(low, 'https://u:p@t.example/1')).statusCode).toBe(400);
    expect((await put(foreign, 'https://t.example/1')).statusCode).toBe(404);

    const ok = await put(low, 'https://t.example/browse/ACME-1');
    expect(ok.json()).toEqual({ id: low, external_ticket_url: 'https://t.example/browse/ACME-1' });
    const got = await app.inject({ method: 'GET', url: `/findings/${low}` });
    expect(got.json().external_ticket_url).toBe('https://t.example/browse/ACME-1');
    expect(audits('finding.external_ticket_set')[0]).toMatchObject({
      findingId: low,
      detail: { from: null, to: 'https://t.example/browse/ACME-1' },
    });

    logs.length = 0;
    await put(low, 'https://t.example/browse/ACME-1');
    expect(audits('finding.external_ticket_set')).toHaveLength(0);

    expect((await put(low, null)).json().external_ticket_url).toBeNull();
    const [after] = await db
      .select({ url: read.findings.externalTicketUrl })
      .from(read.findings)
      .where(eq(read.findings.id, low));
    expect(after!.url).toBeNull();
  });

  it('the database refuses a non-web link written around the API', async () => {
    await expect(
      db
        .update(read.findings)
        .set({ externalTicketUrl: 'javascript:alert(1)' })
        .where(eq(read.findings.id, low)),
    ).rejects.toThrow();
  });
});
