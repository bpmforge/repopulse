import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts } from '@repopulse/analysis';
import { isExcluded, runLoggingScan } from './run.js';
import { loadChecklist } from '../owasp/checklist.js';

// logging_hygiene (W9-04, CODE_HEALTH_SUITE.md §3, FR-CH-4).

const databaseUrl = process.env.DATABASE_URL;
const FP = 'w9-04-fp';

const HANDLER = [
  'const logger = require("./logger");',
  '',
  'function handle(req, res) {',
  '  console.log("request", req.path);',
  '  const name = req.query.name;',
  '  logger.info("searched for " + name);',
  '  try {',
  '    work();',
  '  } catch (e) {',
  '    logger.error(e);',
  '    throw e;',
  '  }',
  '  res.end();',
  '}',
  'module.exports = { handle };',
].join('\n');

const DIFF = [
  '@@ -1,2 +1,6 @@',
  ' function login(req, res) {',
  '+  if (!check(req.body.password)) {',
  '+    return res.status(401).end();',
  '+  }',
  '+  return res.end();',
].join('\n');

const JUDGMENT = JSON.stringify({
  findings: [
    {
      dimension: 'code_health',
      severity: 4,
      confidence: 4,
      file: 'src/login.js',
      line_range: [2, 4],
      title: 'A09-4: authentication failure logs nothing',
      evidence_quote: '    return res.status(401).end();',
      rationale: 'A failed login returns 401 and records nothing an incident could be built from.',
      suggested_fix: 'Log the failure with the request id and the account identifier.',
      preconditions: [],
      yields: ['log-exposure'],
    },
  ],
});

function fakeGateway(calls: CompleteOpts[], text = JUDGMENT): AnalysisGateway {
  return {
    async complete(_prompt: string, opts: CompleteOpts) {
      calls.push(opts);
      return { text, model: 'fake', tokensIn: 5, tokensOut: 5, costUsd: null, durationMs: 1 };
    },
    async health() {
      return { ok: true };
    },
  };
}

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

describe('path exclusion', () => {
  it('keeps production paths and drops test, script and fixture paths', () => {
    // A scanner that fires on test fixtures is one people filter out entirely,
    // and then it is not catching the handler either.
    expect(isExcluded('src/routes/login.ts')).toBe(false);
    expect(isExcluded('apps/api/src/handler.ts')).toBe(false);
    for (const file of [
      'src/routes/login.test.ts',
      'packages/x/src/thing.spec.js',
      'test/helpers/db.ts',
      'e2e/login.spec.ts',
      'scripts/seed.mjs',
      'packages/security/fixtures/code-health/triggering/logging.js',
      'vitest.config.ts',
    ]) {
      expect(isExcluded(file), file).toBe(true);
    }
  });
});

describe('the checklist', () => {
  it('cites its OWASP ids and carries only the judgement items', () => {
    const prompt = loadChecklist('logging').prompt;
    for (const id of ['A09-1', 'A09-2', 'A09-3', 'A09-4', 'A09-5']) {
      expect(prompt, id).toContain(id);
    }
    expect(prompt).toContain('OWASP Logging Cheat Sheet');
    // The deterministic rules are the pack's, and asking about them here would
    // produce two findings for one problem.
    expect(prompt).toContain('are NOT asked about here');
  });
});

const describeIfReady = databaseUrl && scanImage ? describe : describe.skip;

describeIfReady('logging_hygiene scan (W9-04)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let targetDir = '';

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w9-04-user', forgeUserId: 'w9-04-user', login: 'w9-04-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-04-user' } })
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

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w9-04-repo',
        org: 'acme',
        name: 'logging',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // A tree with a production handler AND a test file that does the same
    // things — the test file must contribute nothing.
    targetDir = mkdtempSync(path.join(tmpdir(), 'w9-04-tree-'));
    mkdirSync(path.join(targetDir, 'src'), { recursive: true });
    mkdirSync(path.join(targetDir, 'test'), { recursive: true });
    writeFileSync(path.join(targetDir, 'src', 'handler.js'), HANDLER);
    writeFileSync(path.join(targetDir, 'test', 'handler.test.js'), HANDLER);
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('runs the W9-01 pack over a tree and stores only the LOGGING rules', async () => {
    const calls: CompleteOpts[] = [];
    const result = await runLoggingScan({
      db,
      gateway: fakeGateway(calls),
      workspaceId,
      repoId,
      commitSha: 'w9-04-sha',
      files: [
        { path: 'src/login.js', patch: DIFF },
        // A test file in the same diff: the runner drops it before the model
        // ever sees it, which is the exclusion this counter measures.
        { path: 'test/login.test.js', patch: DIFF },
      ],
      targetDir,
      image: scanImage as string,
      trigger: 'schedule',
      verify: async () => ({ refuted: false, reason: 'confirmed' }),
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    // console.log in a handler, the tainted log call and the log-and-rethrow.
    expect(result.deterministic).toBeGreaterThanOrEqual(3);
    // The excluded counter is about what THIS RUNNER dropped — here, the test
    // file in the diff. The tree copy under test/ never even reaches it: the
    // engine skips test paths by default, so the runner-level globs are
    // belt-and-braces rather than the only guard. Worth knowing, because it
    // means the engine's defaults are load-bearing and a future engine swap
    // would move that line.
    expect(result.excluded).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'logging')));
    const rules = new Set(rows.map((r) => r.ruleId));
    expect([...rules].some((r) => r?.startsWith('bpm-log-'))).toBe(true);
    // The anti-slop half of the same pack belongs to W9-03 — claiming it here
    // would double-report every empty catch in the repository.
    expect([...rules].some((r) => r?.startsWith('bpm-ch-'))).toBe(false);
    // Nothing from a test path reached the store.
    expect(rows.every((r) => !r.file?.startsWith('test/'))).toBe(true);

    // The judgement half ran through the gateway, tagged with its scanner.
    expect(calls[0]?.meta.initiator).toBe('scanner:logging_hygiene');
    expect(calls[0]?.meta.checklistVersion).toBe('logging.v1');
    expect(result.judgment).toBe(1);
  }, 600_000);

  it('a refuted A09 judgement never reaches the store', async () => {
    const result = await runLoggingScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-04-refuted',
      files: [{ path: 'src/login.js', patch: DIFF }],
      trigger: 'pr_synced',
      verify: async () => ({ refuted: true, reason: 'the failure is logged by middleware' }),
    });
    expect(result.refuted).toBe(1);
    expect(result.judgment).toBe(0);
  }, 300_000);

  it('caps judgement severity at 3 and keeps A09-4 chainable', async () => {
    // A missing log line is not itself exploitable — it is what makes the
    // exploitable thing invisible. But an attack that leaves no trace IS a
    // step in a chain, so log-exposure survives as a yields term.
    const result = await runLoggingScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-04-capped',
      files: [{ path: 'src/login.js', patch: DIFF }],
      trigger: 'pr_synced',
      verify: async () => ({ refuted: false, reason: 'confirmed' }),
    });
    expect(result.judgment).toBe(1);

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'logging.judgment')));
    expect(row?.severity).toBe(3);
    expect(row?.yields).toEqual({ 'log-exposure': true });
  }, 300_000);
});
