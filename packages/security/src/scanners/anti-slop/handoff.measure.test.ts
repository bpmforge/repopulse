import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  core,
  createDb,
  FAKE_COMMIT_FILES,
  FIXTURE_SOURCES,
  read,
  security,
  type Database,
} from '@repopulse/shared';
import {
  chunkDiff,
  estimateTokens,
  type AnalysisGateway,
  type DiffFile,
} from '@repopulse/analysis';
import { buildChecklistPrompt, loadChecklist } from '../owasp/checklist.js';
import { readSnapshotSources } from '../../snapshot/sources.js';
import { runAntiSlopScan } from './run.js';

// Before/after measurement of the anti-slop.v2 candidate handoff (W18-10).
// Evidence: docs/work/product-completion/evidence/w18-10-anti-slop-v2-handoff.md.
//
// NO MODEL IS CALLED. Repository code never leaves this machine: "before" is
// the exact prompt v1 built (chunkDiff + buildChecklistPrompt over the diff),
// counted, never sent; "after" is the real scanner with a STUB gateway that
// counts the prompt it is handed and answers deterministically. The stub
// CONFIRMS EVERY CANDIDATE, so its judgement count is the ceiling a real
// model could reach, and its output size the most a v2 answer can cost.
//
// The demo repositories (the fixture forge's fixture-org repos, which all
// serve FIXTURE_SOURCES, with FAKE_COMMIT_FILES as their commit diffs) run in
// every gate. Larger trees run only when asked, because they read a checkout:
//   ANTI_SLOP_MEASURE_DIRS=/path/a,/path/b   trees to measure (git checkouts)
//   ANTI_SLOP_MEASURE_COMMITS=20             recent commits per tree, as PRs
//   ANTI_SLOP_MEASURE_OUT=/tmp/out.json      where to write the numbers

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w18-10-measure-fp';

const v1 = loadChecklist('anti_slop', undefined, { upTo: 1 });

interface Stub {
  gateway: AnalysisGateway;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Candidates handed over, per rule — read back out of the prompts. */
  byRule: Record<string, number>;
}

/**
 * The confirm-all stub. It reads the candidate headings and excerpts back out
 * of the prompt and confirms each one, quoting the flagged line verbatim —
 * what a cooperative model would return, and the worst case for cost.
 */
function confirmAllStub(): Stub {
  const stub: Stub = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    byRule: {},
    gateway: {
      async complete(prompt) {
        stub.calls += 1;
        stub.inputTokens += estimateTokens(prompt);
        const findings = [];
        const block =
          /^### (c\d+) · (\S+) · (.+):(\d+)\n[\s\S]*?^Lines (\d+)-(\d+) of .+:\n(`{3,})\n([\s\S]*?)\n\7$/gm;
        for (const m of prompt.matchAll(block)) {
          const [, id, rule, file, line, from, , , excerpt] = m;
          stub.byRule[rule!] = (stub.byRule[rule!] ?? 0) + 1;
          const lines = (excerpt ?? '').split('\n');
          const quote = lines[Number(line) - Number(from)]?.trim() ?? '';
          if (!quote) continue;
          findings.push({
            candidate: id,
            dimension: 'code_health',
            severity: 1,
            confidence: 4,
            file,
            line_range: [Number(line), Number(line)],
            title: `Confirmed ${rule}`.slice(0, 120),
            evidence_quote: quote,
            rationale: 'The excerpt shows nothing the rule could not see.',
            suggested_fix: null,
            preconditions: [],
            yields: [],
          });
        }
        const text = JSON.stringify({ findings });
        stub.outputTokens += estimateTokens(text);
        return { text, model: 'stub', tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: 0 };
      },
      async health() {
        return { ok: true };
      },
    },
  };
  return stub;
}

/** What v1 would have sent for this diff: same chunker, same prompt builder. */
function v1Cost(files: readonly DiffFile[]) {
  const { chunks } = chunkDiff(files, 'code_health');
  let inputTokens = 0;
  let projectedOutput = 0;
  for (const chunk of chunks) {
    inputTokens += estimateTokens(buildChecklistPrompt(v1, chunk.text));
    projectedOutput += chunk.projectedOutputTokens;
  }
  return { calls: chunks.length, inputTokens, projectedOutputTokens: projectedOutput };
}

/** A whole file as an added-file diff: the snapshot as v1 would have read it. */
function asAdded(file: { path: string; source: string }): DiffFile {
  const lines = file.source.split('\n');
  return {
    path: file.path,
    patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'),
  };
}

/** One commit's diff, split per file the way the forge returns it. */
function commitDiff(dir: string, sha: string): DiffFile[] {
  const raw = execFileSync('git', ['-C', dir, 'show', '--format=', '--unified=3', sha], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out: DiffFile[] = [];
  for (const part of raw.split(/^diff --git /m).slice(1)) {
    const target = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1];
    const hunks = part.indexOf('\n@@');
    if (!target || hunks < 0) continue;
    out.push({ path: target, patch: part.slice(hunks + 1) });
  }
  return out;
}

describeIfLiveInfra('anti-slop.v2 handoff: before/after (W18-10)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  const results: Record<string, unknown>[] = [];

  beforeAll(async () => {
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
        authSubject: 'w18-10-user',
        forgeUserId: 'w18-10-user',
        login: 'w18-10-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-10-user' } })
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
        forgeRepoId: 'w18-10-measure',
        org: 'fixture-org',
        name: 'measure',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
    const out = process.env.ANTI_SLOP_MEASURE_OUT;
    if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  });

  async function measure(
    label: string,
    sources: readonly { path: string; source: string }[],
    diff: readonly DiffFile[],
    scope: 'snapshot' | 'diff',
  ) {
    const stub = confirmAllStub();
    const result = await runAntiSlopScan({
      db,
      gateway: stub.gateway,
      workspaceId,
      repoId,
      commitSha: `w18-10-${label}`.slice(0, 64),
      // The snapshot pass passes no diff; a PR run passes its diff as scope.
      files: scope === 'diff' ? diff : [],
      sources,
      sourcesComplete: true,
      trigger: scope === 'diff' ? 'pr_synced' : 'schedule',
    });
    expect(result.status).toBe('succeeded');
    const before = v1Cost(diff);
    const row = {
      label,
      scope,
      files: sources.length,
      diffFiles: diff.length,
      deterministic: result.deterministic,
      v1: before,
      v2: {
        candidates: result.candidates,
        candidatesCapped: result.candidatesCapped,
        byRule: stub.byRule,
        calls: stub.calls,
        inputTokens: stub.inputTokens,
        stubOutputTokens: stub.outputTokens,
        judgmentConfirmAll: result.judgment,
        rejected: result.rejected,
      },
    };
    results.push(row);
    return row;
  }

  it('the demo repositories: v2 sends no more than v1, and only candidates', async () => {
    const tree = FIXTURE_SOURCES.map((f) => ({ path: f.path, source: f.content }));
    const snapshot = await measure('demo-snapshot', tree, tree.map(asAdded), 'snapshot');
    expect(snapshot.v2.inputTokens).toBeLessThanOrEqual(snapshot.v1.inputTokens);
    for (const [i, commit] of FAKE_COMMIT_FILES.entries()) {
      const diff = commit.map((f) => ({ path: f.path, patch: f.patch }));
      const pr = await measure(`demo-commit-${i}`, tree, diff, 'diff');
      expect(pr.v2.inputTokens).toBeLessThanOrEqual(pr.v1.inputTokens);
      // Confirm-all can confirm at most what it was handed.
      expect(pr.v2.judgmentConfirmAll).toBeLessThanOrEqual(pr.v2.candidates);
    }
  });

  const dirs = (process.env.ANTI_SLOP_MEASURE_DIRS ?? '').split(',').filter(Boolean);
  it.skipIf(dirs.length === 0)(
    'opt-in trees: snapshot and recent commits as pull requests',
    async () => {
      const commits = Number(process.env.ANTI_SLOP_MEASURE_COMMITS ?? 20);
      for (const dir of dirs) {
        const name = path.basename(dir);
        const read = readSnapshotSources(dir, { maxFiles: 5000 });
        await measure(`${name}-snapshot`, read.files, read.files.map(asAdded), 'snapshot');
        const shas = execFileSync(
          'git',
          ['-C', dir, 'log', `-${commits}`, '--no-merges', '--format=%H'],
          { encoding: 'utf8' },
        )
          .split('\n')
          .filter(Boolean);
        for (const sha of shas) {
          await measure(`${name}-${sha.slice(0, 8)}`, read.files, commitDiff(dir, sha), 'diff');
        }
      }
    },
    600_000,
  );
});
