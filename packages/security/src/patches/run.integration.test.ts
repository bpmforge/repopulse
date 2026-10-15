import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts } from '@repopulse/analysis';
import type { ForgeProvider } from '@repopulse/forge';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPatchDraft } from './run.js';
import { hitDedupKey, type FileRuleRunner, type RuleHit } from './verify.js';

// The patch-drafting job end to end against Postgres (W18-19): a stubbed model,
// a stubbed forge, a stub rule runner. What is proven is the job's contract —
// the row it writes for each outcome, idempotency, and that it only ever READS
// from the forge (D9a).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w18-19-patch-fp';
const FILE = 'src/run.js';
const SOURCE = 'function run(cmd) {\n  return eval(cmd);\n}\n\nmodule.exports = { run };\n';
const SHA = 'a'.repeat(40);

function evalHits(file: string, source: string): RuleHit[] {
  return source.split('\n').flatMap((t, i) =>
    t.includes('eval(') || t.includes('innerHTML')
      ? [
          {
            scannerKey: 'semgrep',
            ruleId: t.includes('eval(') ? 'bpm-eval' : 'bpm-inner-html',
            dimension: 'sast',
            file,
            lineStart: i + 1,
            evidenceQuote: `${file}:${i + 1} — ${t.includes('eval(') ? 'bpm-eval' : 'bpm-inner-html'}`,
            title: 'stub',
          },
        ]
      : [],
  );
}

const runner: FileRuleRunner = {
  key: 'stub_pack',
  scannerKeys: ['semgrep'],
  async run(input) {
    return { status: 'succeeded', hits: evalHits(input.file, input.source) };
  },
};

const FIX = JSON.stringify({
  diff: [
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    '@@ -1,3 +1,3 @@',
    ' function run(cmd) {',
    '-  return eval(cmd);',
    '+  return JSON.parse(cmd);',
    ' }',
  ].join('\n'),
});
const NEW_FINDING = JSON.stringify({
  diff: [
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    '@@ -1,3 +1,3 @@',
    ' function run(cmd) {',
    '-  return eval(cmd);',
    '+  return document.body.innerHTML = cmd;',
    ' }',
  ].join('\n'),
});

function stubGateway(
  text: string,
  calls: { prompt: string; opts: CompleteOpts }[],
): AnalysisGateway {
  return {
    async complete(prompt, opts) {
      calls.push({ prompt, opts });
      return {
        text,
        model: 'stub-model@1',
        tokensIn: 100,
        tokensOut: 40,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

/**
 * A forge that records every member touched and permits only the reads a
 * patch needs. Anything else — a write that does not exist on the port yet,
 * or one somebody adds later — throws, and the call list proves what ran.
 */
function readOnlyForge(touched: string[]): ForgeProvider {
  const allowed = new Set(['kind', 'capabilities', 'getFileContent']);
  const impl: Partial<ForgeProvider> = {
    kind: 'github',
    capabilities: { supportsTarball: false } as ForgeProvider['capabilities'],
    async getFileContent(_ctx, _repo, filePath, ref) {
      return { path: filePath, ref, sizeBytes: SOURCE.length, content: SOURCE, truncated: false };
    },
  };
  return new Proxy(impl as ForgeProvider, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        touched.push(prop);
        if (!allowed.has(prop) && prop !== 'then') {
          throw new Error(`forge member "${prop}" is not permitted on the patch path (D9a)`);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describeIfLiveInfra('runPatchDraft (W18-19)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let findingId = 0;
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rp-patch-run-'));
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w18-19-user',
        forgeUserId: 'w18-19-user',
        login: 'w18-19-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-19-user' } })
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
        forgeRepoId: 'w18-19-repo',
        org: 'acme',
        name: 'patches',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: SHA,
        trigger: 'schedule',
        status: 'succeeded',
      })
      .returning();
    const hit = evalHits(FILE, SOURCE)[0]!;
    const [finding] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        scanRunId: run!.id,
        dimension: 'sast',
        severity: 4,
        confidence: 3,
        title: 'eval of input',
        file: FILE,
        lineStart: 2,
        lineEnd: 2,
        evidence: hit.evidenceQuote,
        recommendation: 'Do not eval input.',
        tier: 1,
        dedupKey: hitDedupKey(hit),
        status: 'open',
        scannerKey: 'semgrep',
        ruleId: 'bpm-eval',
      })
      .returning();
    findingId = finding!.id;
  });

  beforeEach(async () => {
    await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.findingId, findingId));
  });

  afterAll(async () => {
    await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.repoId, repoId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
    await rm(root, { recursive: true, force: true });
  });

  async function pending(tier: 2 | 3 = 2): Promise<number> {
    const [finding] = await db.select().from(read.findings).where(eq(read.findings.id, findingId));
    const [row] = await db
      .insert(read.verifiedPatches)
      .values({
        workspaceId,
        repoId,
        findingId,
        commitSha: SHA,
        targetDedupKey: finding!.dedupKey,
        tier,
        requestedBy: userId,
      })
      .returning();
    return row!.id;
  }

  async function rowOf(id: number) {
    const [row] = await db
      .select()
      .from(read.verifiedPatches)
      .where(eq(read.verifiedPatches.id, id));
    return row!;
  }

  it('a correct fix is stored VERIFIED with its canonical diff, model and runs', async () => {
    const calls: { prompt: string; opts: CompleteOpts }[] = [];
    const touched: string[] = [];
    const id = await pending();
    const result = await runPatchDraft({
      db,
      workspaceId,
      patchId: id,
      gateway: stubGateway(FIX, calls),
      forge: { provider: readOnlyForge(touched), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    expect(result.status).toBe('verified');
    const row = await rowOf(id);
    expect(row.status).toBe('verified');
    expect(row.diff).toContain('+  return JSON.parse(cmd);');
    expect(row.modelId).toBe('stub-model@1');
    expect(row.verificationRuns).toHaveLength(2);
    expect(row.finishedAt).not.toBeNull();
    // Local model by default: Tier-2, the 45000 cap, and the file in the prompt.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.tier).toBe('T2');
    expect(calls[0]!.prompt).toContain('return eval(cmd);');
    // D9a: the only forge member this path touched is the file read.
    expect([...new Set(touched)].sort()).toEqual(['capabilities', 'getFileContent']);
  });

  it('a fix that adds a new finding is stored REJECTED with the reason', async () => {
    const id = await pending();
    const result = await runPatchDraft({
      db,
      workspaceId,
      patchId: id,
      gateway: stubGateway(NEW_FINDING, []),
      forge: { provider: readOnlyForge([]), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    expect(result.status).toBe('rejected');
    const row = await rowOf(id);
    expect(row.status).toBe('rejected');
    expect(row.reasonCode).toBe('new_finding');
    expect(row.reason).toContain('bpm-inner-html');
  });

  it('a malformed or no-op diff is stored REJECTED at the shape gate', async () => {
    const id = await pending();
    await runPatchDraft({
      db,
      workspaceId,
      patchId: id,
      gateway: stubGateway('I cannot fix this.', []),
      forge: { provider: readOnlyForge([]), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    const row = await rowOf(id);
    expect(row.status).toBe('rejected');
    expect(row.reasonCode).toBe('diff_malformed');
  });

  it('is idempotent: a decided row is never drafted again', async () => {
    const calls: { prompt: string; opts: CompleteOpts }[] = [];
    const id = await pending();
    const deps = {
      db,
      workspaceId,
      patchId: id,
      gateway: stubGateway(FIX, calls),
      forge: { provider: readOnlyForge([]), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    };
    await runPatchDraft(deps);
    const again = await runPatchDraft(deps);
    expect(again.status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('no model configured is FAILED by name, with no forge call at all', async () => {
    const touched: string[] = [];
    const id = await pending();
    const result = await runPatchDraft({
      db,
      workspaceId,
      patchId: id,
      gateway: null,
      forge: { provider: readOnlyForge(touched), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    expect(result).toMatchObject({ status: 'failed', code: 'no_gateway' });
    expect(touched).toEqual([]);
  });

  it('a Tier-3 request goes to the gateway as T3, where the opt-in is enforced', async () => {
    const calls: { prompt: string; opts: CompleteOpts }[] = [];
    const id = await pending(3);
    await runPatchDraft({
      db,
      workspaceId,
      patchId: id,
      gateway: stubGateway(FIX, calls),
      forge: { provider: readOnlyForge([]), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    expect(calls[0]!.opts.tier).toBe('T3');
  });

  it("another workspace cannot run this workspace's request", async () => {
    const id = await pending();
    const result = await runPatchDraft({
      db,
      workspaceId: workspaceId + 100_000,
      patchId: id,
      gateway: stubGateway(FIX, []),
      forge: { provider: readOnlyForge([]), repoFullName: 'acme/patches' },
      runners: [runner],
      root,
    });
    expect(result).toMatchObject({ status: 'skipped', code: 'not_found' });
    expect((await rowOf(id)).status).toBe('pending');
  });
});
