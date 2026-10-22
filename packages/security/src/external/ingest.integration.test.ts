import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { persistFindings, repriceFindings } from '@repopulse/insights';
import {
  ForgeHttpError,
  type ForgeCodeScanningAlert,
  type ForgeCursor,
  type ForgeProvider,
  type Page,
} from '@repopulse/forge';
import { ingestSarifUpload } from './upload.js';
import { runCodeScanningPull, CODE_SCANNING_PULL_KEY } from './code-scanning.js';

// External findings end to end (W18-24): SARIF uploads and the code-scanning
// pull land in the real findings store, dedupe against our own pack findings,
// sweep only their own tool's findings, and are priced by the same reprice
// that prices everything else.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/external/sarif');
type Json = Record<string, unknown>;
const load = (name: string): Json =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Json;

const WS = 'w18-24-external';
const FP = 'w18-24-fp';

/** A copy of a fixture with a filter over its first run's results. */
function withResults(doc: Json, keep: (r: Json) => boolean, edit?: (r: Json) => Json): Json {
  const copy = structuredClone(doc) as { runs: { results: Json[] }[] };
  copy.runs[0]!.results = copy.runs[0]!.results.filter(keep).map((r) => (edit ? edit(r) : r));
  return copy as unknown as Json;
}

function alert(
  n: number,
  tool: string,
  rule: string,
  file: string,
  line: number,
): ForgeCodeScanningAlert {
  return {
    number: n,
    state: 'open',
    ruleId: rule,
    ruleName: rule,
    ruleDescription: `${rule} description`,
    ruleSeverity: 'warning',
    securitySeverityLevel: 'medium',
    ruleTags: ['security'],
    toolName: tool,
    toolVersion: '1.0.0',
    path: file,
    startLine: line,
    endLine: line,
    message: `${rule} fired`,
    commitSha: null,
    htmlUrl: null,
  };
}

/** A mocked forge: pages of alerts, or an error, and a record of each call. */
function mockProvider(
  pages: ForgeCodeScanningAlert[][] | Error,
  calls: { lane: string; cursor?: ForgeCursor }[] = [],
  /** W20-25 (FND-63): one page each of dismissed and fixed alerts. */
  closed: { dismissed?: ForgeCodeScanningAlert[]; fixed?: ForgeCodeScanningAlert[] } = {},
): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsCodeScanningAlerts: true },
    listCodeScanningAlerts: async (
      ctx: { lane: string },
      _repo: string,
      cursor?: ForgeCursor,
      opts?: { state?: string },
    ): Promise<Page<ForgeCodeScanningAlert>> => {
      if (opts?.state === 'dismissed' || opts?.state === 'fixed') {
        return { items: closed[opts.state] ?? [] };
      }
      calls.push({ lane: ctx.lane, ...(cursor ? { cursor } : {}) });
      if (pages instanceof Error) throw pages;
      const i = cursor ? Number(cursor) : 0;
      return {
        items: pages[i] ?? [],
        ...(i + 1 < pages.length ? { nextCursor: String(i + 1) } : {}),
      };
    },
  } as unknown as ForgeProvider;
}

describeIfDb('external findings (W18-24)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let userId = 0;
  let repoId = 0;
  let pullRepoId = 0;
  let ourWeakHashId = 0;
  let ourUtilFindingId = 0;
  let ourRunId = 0;

  const statusOf = async (id: number) =>
    (
      await db
        .select({ s: read.findings.status })
        .from(read.findings)
        .where(eq(read.findings.id, id))
    )[0]!.s;

  const external = async (repo: number, scannerKey: string) =>
    db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repo), eq(read.findings.scannerKey, scannerKey)));

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: WS, name: 'W18-24' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'W18-24' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'local', authSubject: 'w18-24@example.com', login: 'w18-24' })
      .returning();
    userId = user!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: FP,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    const repo = (name: string) => ({
      workspaceId,
      connectionId: conn!.id,
      forgeRepoId: `w18-24-${name}`,
      org: 'acme',
      name,
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    });
    repoId = (await db.insert(core.repos).values(repo('widgets')).returning())[0]!.id;
    pullRepoId = (await db.insert(core.repos).values(repo('pulled')).returning())[0]!.id;

    // OUR OWN findings, from our semgrep scanner, before anything external
    // arrives: one the dedup map says CodeQL's weak-crypto yields to, and one
    // on a file the external sweep will look at and must leave alone.
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'semgrep.v1',
        commitSha: 'abc',
        trigger: 'schedule',
        status: 'succeeded',
      })
      .returning();
    ourRunId = run!.id;
    const ours = (ruleId: string, file: string, line: number) => ({
      dimension: 'sast',
      severity: 3,
      confidence: 3,
      file,
      lineStart: line,
      lineEnd: line,
      title: ruleId,
      evidenceQuote: `${file}:${line} — ${ruleId}`,
      rationale: 'ours',
      suggestedFix: null,
      scannerKey: 'semgrep',
      ruleId,
    });
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId: ourRunId,
      pullRequestId: null,
      tier: 1,
      findings: [
        ours('bpm-js-weak-hash', 'src/crypto.js', 9),
        ours('bpm-js-other', 'src/util.js', 3),
      ],
    });
    const rows = await external(repoId, 'semgrep');
    ourWeakHashId = rows.find((r) => r.ruleId === 'bpm-js-weak-hash')!.id;
    ourUtilFindingId = rows.find((r) => r.ruleId === 'bpm-js-other')!.id;
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.workspaceId, workspaceId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('a CodeQL upload lands with tool provenance; weak-crypto yields to our pack rule', async () => {
    const result = await ingestSarifUpload({
      db,
      workspaceId,
      repoId,
      document: load('codeql.sarif.json'),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.commitSha).toBe('3f786850e387550fdab836ed7e6dc881de23001b');
    expect(result.skipped).toEqual({ suppressed: 1 });
    expect(result.tools).toHaveLength(1);
    const [tool] = result.tools;
    expect(tool).toMatchObject({
      scannerKey: 'external:codeql',
      tool: 'CodeQL',
      toolVersion: '2.19.0',
      results: 3,
      created: 2,
      supersededByPack: [
        {
          ruleId: 'js/weak-cryptographic-algorithm',
          packRule: 'bpm-js-weak-hash',
          file: 'src/crypto.js',
          line: 8,
        },
      ],
    });

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, tool!.scanRunId));
    expect(run).toMatchObject({
      scannerKey: 'external:codeql',
      scannerVersion: 'codeql@2.19.0',
      status: 'succeeded',
      trigger: 'manual',
      commitSha: '3f786850e387550fdab836ed7e6dc881de23001b',
      findingCount: 2,
    });
    expect(run!.toolVersions).toEqual({ codeql: '2.19.0', intake: 'sarif-2.1.0' });

    const stored = await external(repoId, 'external:codeql');
    expect(stored.map((f) => [f.ruleId, f.dimension, f.severity, f.file]).sort()).toEqual([
      ['external.codeql.js/sql-injection', 'sast', 4, 'src/db.js'],
      ['external.codeql.js/unused-local-variable', 'code_health', 2, 'src/util.js'],
    ]);
    expect(stored.every((f) => f.scanRunId === tool!.scanRunId && f.status === 'open')).toBe(true);
    // Our own finding is untouched.
    expect(await statusOf(ourWeakHashId)).toBe('open');
  });

  it('re-uploading — even with the line moved — creates nothing new (fingerprint dedup)', async () => {
    const moved = withResults(
      load('codeql.sarif.json'),
      () => true,
      (r) => {
        const copy = structuredClone(r) as {
          locations: { physicalLocation: { region: { startLine: number } } }[];
        };
        copy.locations[0]!.physicalLocation.region.startLine += 40;
        return copy as unknown as Json;
      },
    );
    const result = await ingestSarifUpload({ db, workspaceId, repoId, document: moved });
    if (!result.ok) throw new Error('invalid');
    // The weak-crypto result moved away from our pack finding, so it is no
    // longer the same defect and is stored this time — the other two are
    // sightings of rows that already exist.
    expect(result.tools[0]).toMatchObject({ created: 1, updated: 2, supersededByPack: [] });
    expect(await external(repoId, 'external:codeql')).toHaveLength(3);
  });

  it('an upload sweeps only its own tool: our findings on the same files stay open', async () => {
    // CodeQL no longer reports the unused variable on src/util.js. Our own
    // finding on that same file must survive the sweep.
    const without = withResults(
      load('codeql.sarif.json'),
      (r) => r['ruleId'] !== 'js/unused-local-variable',
    );
    const result = await ingestSarifUpload({ db, workspaceId, repoId, document: without });
    if (!result.ok) throw new Error('invalid');
    // Two closed: the unused variable CodeQL stopped reporting, and the
    // weak-crypto row, which is back at our pack finding's place and so is a
    // duplicate of it again — superseded results are not "seen".
    expect(result.tools[0]!.autoResolved).toBe(2);
    expect(result.tools[0]!.supersededByPack).toHaveLength(1);

    const codeql = await external(repoId, 'external:codeql');
    expect(codeql.map((f) => [f.ruleId, f.status]).sort()).toEqual([
      ['external.codeql.js/sql-injection', 'open'],
      ['external.codeql.js/unused-local-variable', 'resolved'],
      ['external.codeql.js/weak-cryptographic-algorithm', 'resolved'],
    ]);
    // Our own findings on those same files are not CodeQL's to close.
    expect(await statusOf(ourUtilFindingId)).toBe('open');
    expect(await statusOf(ourWeakHashId)).toBe('open');
  });

  it('sweep=false (a partial upload) closes nothing', async () => {
    // Only the unused-variable result: as a full upload this would close the
    // SQL injection finding; as a partial one it must not.
    const onlyUnused = withResults(
      load('codeql.sarif.json'),
      (r) => r['ruleId'] === 'js/unused-local-variable' && !r['suppressions'],
    );
    const result = await ingestSarifUpload({
      db,
      workspaceId,
      repoId,
      document: onlyUnused,
      sweep: false,
    });
    if (!result.ok) throw new Error('invalid');
    expect(result.tools[0]).toMatchObject({ autoResolved: 0, reopened: 1 });
    const sqli = (await external(repoId, 'external:codeql')).find((f) =>
      f.ruleId?.endsWith('sql-injection'),
    );
    expect(sqli!.status).toBe('open');
  });

  it('our own scanner’s sweep never closes an external finding on a file it reviewed', async () => {
    const swept = await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId: ourRunId,
      pullRequestId: null,
      tier: 1,
      findings: [],
      reviewedFiles: ['src/db.js', 'src/crypto.js'],
      sweepScannerKey: 'semgrep',
    });
    // It closed its OWN weak-hash finding on src/crypto.js — and nothing else.
    expect(swept.autoResolved).toBe(1);
    expect(await statusOf(ourWeakHashId)).toBe('resolved');
    const codeql = await external(repoId, 'external:codeql');
    expect(codeql.find((f) => f.file === 'src/db.js')!.status).toBe('open');
  });

  it('another tool’s upload neither dedupes against nor sweeps CodeQL', async () => {
    const result = await ingestSarifUpload({
      db,
      workspaceId,
      repoId,
      document: load('eslint.sarif.json'),
    });
    if (!result.ok) throw new Error('invalid');
    expect(result.tools.map((t) => [t.scannerKey, t.created, t.autoResolved])).toEqual([
      ['external:eslint', 3, 0],
    ]);
    const codeqlOpen = (await external(repoId, 'external:codeql')).filter(
      (f) => f.status === 'open',
    );
    // sql-injection and the reopened unused variable.
    expect(codeqlOpen).toHaveLength(2);
  });

  it('a semgrep upload of our own bpm rule yields to our live finding at that place', async () => {
    // Our pack already flags src/server.js:12 for eval — as our semgrep would.
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId: ourRunId,
      pullRequestId: null,
      tier: 1,
      findings: [
        {
          dimension: 'sast',
          severity: 4,
          confidence: 3,
          file: 'src/server.js',
          lineStart: 12,
          lineEnd: 12,
          title: 'eval',
          evidenceQuote: 'src/server.js:12 — bpm-js-eval-dynamic',
          rationale: 'ours',
          suggestedFix: null,
          scannerKey: 'semgrep',
          ruleId: 'bpm-js-eval-dynamic',
        },
      ],
    });
    const result = await ingestSarifUpload({
      db,
      workspaceId,
      repoId,
      document: load('semgrep.sarif.json'),
    });
    if (!result.ok) throw new Error('invalid');
    expect(result.tools[0]).toMatchObject({
      scannerKey: 'external:semgrep-oss',
      created: 1,
      supersededByPack: [{ packRule: 'bpm-js-eval-dynamic', file: 'src/server.js', line: 12 }],
    });
    const [kept] = await external(repoId, 'external:semgrep-oss');
    expect(kept).toMatchObject({
      ruleId: 'external.semgrep-oss.team.no-hardcoded-tmp',
      dimension: 'code_health',
    });
  });

  it('the risk model prices external findings like any other', async () => {
    await repriceFindings({ db, workspaceId, repoId });
    const priced = (await external(repoId, 'external:codeql')).find((f) => f.file === 'src/db.js')!;
    expect(priced.effectiveRisk).not.toBeNull();
    expect(priced.riskBand).toMatch(/^(act|schedule|track)$/);
    const factors = priced.riskFactors as {
      H: number;
      inputs: { dimension: string; severity: number };
    };
    expect(factors.inputs).toMatchObject({ dimension: 'sast', severity: 4 });
    expect(factors.H).toBeCloseTo(0.8);
  });

  it('a malformed upload stores nothing and says where it failed', async () => {
    const before = (
      await db.select().from(security.scanRuns).where(eq(security.scanRuns.repoId, repoId))
    ).length;
    const result = await ingestSarifUpload({
      db,
      workspaceId,
      repoId,
      document: { version: '2.1.0', runs: [{ tool: { driver: {} } }] },
    });
    expect(result.ok).toBe(false);
    const after = (
      await db.select().from(security.scanRuns).where(eq(security.scanRuns.repoId, repoId))
    ).length;
    expect(after).toBe(before);
  });

  describe('GitHub code-scanning pull, mocked forge', () => {
    it('imports open alerts per tool through the scan lane', async () => {
      const calls: { lane: string; cursor?: ForgeCursor }[] = [];
      const provider = mockProvider(
        [
          [
            alert(1, 'CodeQL', 'js/xss', 'src/a.js', 10),
            alert(2, 'CodeQL', 'js/xss', 'src/b.js', 3),
          ],
          [alert(3, 'Trivy', 'DS002', 'Dockerfile', 1)],
        ],
        calls,
      );
      const result = await runCodeScanningPull({
        db,
        provider,
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(result).toMatchObject({ status: 'succeeded', alerts: 3, partial: false });
      expect(calls).toEqual([{ lane: 'scan' }, { lane: 'scan', cursor: '1' }]);
      expect(result.tools.map((t) => [t.scannerKey, t.created])).toEqual([
        ['external:codeql:code-scanning', 2],
        ['external:trivy:code-scanning', 1],
      ]);
      const trivy = await external(pullRepoId, 'external:trivy:code-scanning');
      expect(trivy[0]).toMatchObject({ dimension: 'iac', severity: 3, file: 'Dockerfile' });

      const [pullRun] = await db
        .select()
        .from(security.scanRuns)
        .where(eq(security.scanRuns.id, result.scanRunId!));
      expect(pullRun).toMatchObject({
        scannerKey: CODE_SCANNING_PULL_KEY,
        status: 'succeeded',
        findingCount: 3,
      });
    });

    it('closes alerts that are no longer open, including a tool that vanished', async () => {
      const provider = mockProvider([[alert(1, 'CodeQL', 'js/xss', 'src/a.js', 10)]]);
      const result = await runCodeScanningPull({
        db,
        provider,
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(result.status).toBe('succeeded');
      const codeql = await external(pullRepoId, 'external:codeql:code-scanning');
      expect(codeql.map((f) => [f.file, f.status]).sort()).toEqual([
        ['src/a.js', 'open'],
        ['src/b.js', 'resolved'],
      ]);
      const trivy = await external(pullRepoId, 'external:trivy:code-scanning');
      expect(trivy[0]!.status).toBe('resolved');
    });

    it('a missing permission is a reported skip that closes nothing', async () => {
      const provider = mockProvider(
        new ForgeHttpError(403, 'code_scanning_alerts', 'Resource not accessible by integration'),
      );
      const result = await runCodeScanningPull({
        db,
        provider,
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(result).toMatchObject({
        status: 'skipped',
        skipped: 'no_code_scanning_permission',
        detail: 'Resource not accessible by integration',
      });
      const open = (await external(pullRepoId, 'external:codeql:code-scanning')).filter(
        (f) => f.status === 'open',
      );
      expect(open).toHaveLength(1);
    });

    it('code scanning off (404) is its own skip; other failures throw for the queue to retry', async () => {
      const off = await runCodeScanningPull({
        db,
        provider: mockProvider(
          new ForgeHttpError(404, 'code_scanning_alerts', 'no analysis found'),
        ),
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(off.skipped).toBe('code_scanning_not_enabled');
      await expect(
        runCodeScanningPull({
          db,
          provider: mockProvider(new ForgeHttpError(502, 'code_scanning_alerts', null)),
          workspaceId,
          repoId: pullRepoId,
          repo: 'acme/pulled',
        }),
      ).rejects.toBeInstanceOf(ForgeHttpError);
    });

    it('GitLab/Gitea (no capability) are not supported, and nothing is called', async () => {
      const provider = { kind: 'gitlab', capabilities: {} } as unknown as ForgeProvider;
      const result = await runCodeScanningPull({
        db,
        provider,
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(result).toMatchObject({ status: 'skipped', skipped: 'code_scanning_not_supported' });
    });

    it('a pull cut short by the page cap stores what it read and sweeps nothing', async () => {
      const provider = mockProvider([
        [alert(9, 'CodeQL', 'js/other', 'src/c.js', 1)],
        [alert(10, 'CodeQL', 'js/other', 'src/d.js', 1)],
      ]);
      const result = await runCodeScanningPull({
        db,
        provider,
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
        maxPages: 1,
      });
      expect(result).toMatchObject({ status: 'succeeded', partial: true, alerts: 1 });
      const open = (await external(pullRepoId, 'external:codeql:code-scanning'))
        .filter((f) => f.status === 'open')
        .map((f) => f.file)
        .sort();
      // src/a.js is NOT in the first page and stays open: a partial pull has
      // not observed that it is gone.
      expect(open).toEqual(['src/a.js', 'src/c.js']);
      const [run] = await db
        .select()
        .from(security.scanRuns)
        .where(eq(security.scanRuns.id, result.scanRunId!));
      expect(run).toMatchObject({ partial: true });
    });

    it("copies GitHub's dismissed and fixed state, with who and why (W20-25, FND-63)", async () => {
      const dismissed = (n: number, file: string, line: number): ForgeCodeScanningAlert => ({
        ...alert(n, 'CodeQL', 'js/xss', file, line),
        state: 'dismissed',
        dismissedBy: 'ada',
        dismissedReason: 'false positive',
        dismissedComment: 'input is sanitised upstream',
        dismissedAt: '2026-10-01T00:00:00Z',
        fixedAt: null,
      });
      const fixed: ForgeCodeScanningAlert = {
        ...alert(9, 'CodeQL', 'js/other', 'src/c.js', 1),
        state: 'fixed',
        fixedAt: '2026-10-02T08:00:00Z',
      };
      const result = await runCodeScanningPull({
        db,
        provider: mockProvider([[]], [], {
          // #1 is open here; #2 was resolved by an earlier sweep, which read
          // the dismissal as a fix and is corrected now.
          dismissed: [dismissed(1, 'src/a.js', 10), dismissed(2, 'src/b.js', 3)],
          fixed: [fixed],
        }),
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(result).toMatchObject({ status: 'succeeded', githubDismissed: 2, githubFixed: 1 });
      const codeql = await external(pullRepoId, 'external:codeql:code-scanning');
      const byFile = new Map(codeql.map((f) => [f.file, f]));
      expect(byFile.get('src/a.js')).toMatchObject({
        status: 'dismissed',
        dismissReason: 'false_positive',
      });
      expect(byFile.get('src/b.js')).toMatchObject({ status: 'dismissed' });
      expect(byFile.get('src/c.js')).toMatchObject({ status: 'resolved' });

      const events = await db
        .select()
        .from(read.findingEvents)
        .where(eq(read.findingEvents.findingId, byFile.get('src/a.js')!.id));
      const last = events.sort((a, b) => b.id - a.id)[0]!;
      expect(last).toMatchObject({
        fromStatus: 'open',
        toStatus: 'dismissed',
        actor: null,
        reason: 'dismissed on GitHub by ada: false positive (input is sanitised upstream)',
      });
      const cEvents = await db
        .select()
        .from(read.findingEvents)
        .where(eq(read.findingEvents.findingId, byFile.get('src/c.js')!.id));
      expect(cEvents.map((e) => e.reason)).toContain('fixed on GitHub (2026-10-02)');

      // Pulled again: nothing changes twice.
      const again = await runCodeScanningPull({
        db,
        provider: mockProvider([[]], [], {
          dismissed: [dismissed(1, 'src/a.js', 10)],
          fixed: [fixed],
        }),
        workspaceId,
        repoId: pullRepoId,
        repo: 'acme/pulled',
      });
      expect(again).toMatchObject({ githubDismissed: 0, githubFixed: 0 });
    });
  });
});
