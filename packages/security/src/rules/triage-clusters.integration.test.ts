import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, read, security } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts, CompleteResult } from '@repopulse/analysis';
import { loadTriageJudgements, runStoredVerdictTweakPass } from './triage-clusters.js';
import { RULEPACKS_DIR } from './shipped-ids.js';

// W22-06. The weekly pass over the AI judge's STORED verdicts: it proposes, and
// it cannot promote a rule or change one that exists - not in the registry,
// not on disk. Against a real database, because the guarantee is about rows.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const NOW = new Date('2026-10-29T12:00:00Z');

function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else h.update(full).update(readFileSync(full));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const draft = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    domain: 'slop',
    layer: 'llm',
    severity: 2,
    languages: ['ts'],
    checklistItem: "Is this console output the tool's interface?",
    fixtures: { trigger: ['console.log(secret)'], clean: ['console.log(report)'] },
    ...extra,
  });

/** Answers by the rule named in the prompt; `throw` simulates a timeout. */
function scripted(answers: Record<string, string | 'throw'>) {
  const prompts: string[] = [];
  const calls: CompleteOpts[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt: string, o: CompleteOpts): Promise<CompleteResult> {
      prompts.push(prompt);
      calls.push(o);
      const rule = /^Rule (\S+) fired/m.exec(prompt)?.[1] ?? '';
      const a = answers[rule];
      if (a === 'throw') throw new Error('The model did not answer within 300 s');
      return {
        text: a ?? '{}',
        model: 'scripted',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, prompts, calls };
}

describeIfDb('the weekly tweak pass over stored AI verdicts (W22-06)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  const repos: Record<number, number> = {};
  const runs: Record<number, number> = {};
  const scanRuns: number[] = [];
  const connections: number[] = [];

  async function workspace(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.findings).where(eq(read.findings.workspaceId, w));
      await db.delete(security.ruleRegistry).where(eq(security.ruleRegistry.workspaceId, w));
    }
  }

  beforeAll(async () => {
    WS = await workspace('w22-06-ws');
    OTHER = await workspace('w22-06-other');
    await clear();
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w22-06@example.test',
        login: 'w22-06',
        email: 'w22-06@example.test',
      })
      .onConflictDoNothing();
    const userId = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w22-06@example.test'))
        .limit(1)
    )[0]!.id;
    for (const ws of [WS, OTHER]) {
      const [conn] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: ws,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('x'),
          credentialIv: Buffer.from('iv-1234567890123'),
          keyVersion: 1,
          credentialFingerprint: `w22-06-${ws}-${Date.now()}`,
          status: 'active',
          createdBy: userId,
        })
        .returning({ id: core.forgeConnections.id });
      connections.push(conn!.id);
      const [repo] = await db
        .insert(core.repos)
        .values({
          workspaceId: ws,
          connectionId: conn!.id,
          forgeRepoId: `w22-06-${ws}-${Date.now()}`,
          org: 'w22-06',
          name: `r${ws}`,
          defaultBranch: 'main',
          isPrivate: false,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning({ id: core.repos.id });
      repos[ws] = repo!.id;
      const [sr] = await db
        .insert(security.scanRuns)
        .values({
          workspaceId: ws,
          repoId: repo!.id,
          scannerKey: 'semgrep',
          scannerVersion: 'test',
          commitSha: 'abc',
          trigger: 'manual',
          status: 'succeeded',
          startedAt: NOW,
          finishedAt: NOW,
        })
        .returning({ id: security.scanRuns.id });
      scanRuns.push(sr!.id);
      const [run] = await db
        .insert(read.aiPassRuns)
        .values({
          workspaceId: ws,
          repoId: repo!.id,
          paths: [],
          mode: 'judge',
          trigger: 'after_scan',
          status: 'succeeded',
        })
        .returning({ id: read.aiPassRuns.id });
      runs[ws] = run!.id;
    }
  });

  afterAll(async () => {
    await clear();
    await db.delete(read.aiPassRuns).where(inArray(read.aiPassRuns.id, Object.values(runs)));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.id, scanRuns));
    await db.delete(core.repos).where(inArray(core.repos.id, Object.values(repos)));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, connections));
    await db.$client.end();
  });

  beforeEach(clear);

  let seq = 0;
  /** A rule hit and the AI judge's verdict on it. */
  async function judged(
    ws: number,
    ruleId: string,
    verdict: 'real' | 'likely_false_positive' | 'needs_human',
    over: {
      evidence?: string;
      decision?: 'accepted' | 'dismissed' | 'superseded';
      createdAt?: Date;
      confidence?: number;
    } = {},
  ) {
    seq += 1;
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: ws,
        repoId: repos[ws]!,
        scanRunId: scanRuns[ws === WS ? 0 : 1]!,
        dimension: 'slop',
        severity: 2,
        confidence: 3,
        title: `hit ${seq}`,
        scannerKey: 'semgrep',
        ruleId,
        file: `src/f${seq}.ts`,
        lineStart: 1,
        lineEnd: 1,
        evidence: over.evidence ?? `console.log(x${seq})`,
        recommendation: 'r',
        tier: 1,
        dedupKey: `w22-06-${seq}-${Math.random().toString(36).slice(2)}`,
        status: 'open',
      })
      .returning({ id: read.findings.id, status: read.findings.status });
    await db.insert(read.aiTriageVerdicts).values({
      workspaceId: ws,
      findingId: f!.id,
      aiPassRunId: runs[ws]!,
      verdict,
      confidence: over.confidence ?? 4,
      model: 'scripted',
      checklistVersion: 'triage.v1',
      rationale: `judged ${verdict}`,
      citations: [{ file: `src/f${seq}.ts`, line: 1, text: `console.log(x${seq});` }],
      ...(over.decision
        ? { decision: over.decision, ...(over.decision !== 'superseded' ? { decidedAt: NOW } : {}) }
        : {}),
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    });
    return f!.id;
  }

  const registry = async (ws: number) =>
    db
      .select()
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, ws))
      .orderBy(asc(security.ruleRegistry.ruleId));

  it('loads only this workspace, recent, undisputed first opinions', async () => {
    await judged(WS, 'slop.a', 'likely_false_positive', { evidence: 'mine' });
    await judged(WS, 'slop.a', 'likely_false_positive', { decision: 'dismissed' });
    await judged(WS, 'slop.a', 'likely_false_positive', { decision: 'superseded' });
    await judged(WS, 'slop.a', 'likely_false_positive', { decision: 'accepted' });
    await judged(WS, 'slop.a', 'likely_false_positive', {
      createdAt: new Date(NOW.getTime() - 40 * 86_400_000),
    });
    await judged(OTHER, 'slop.a', 'likely_false_positive', { evidence: 'theirs' });
    const js = await loadTriageJudgements(db, WS, NOW);
    expect(js).toHaveLength(2);
    expect(js.map((j) => j.evidence)).toContain('mine');
    expect(js.every((j) => j.evidence !== 'theirs')).toBe(true);
    expect(js[0]!.citedLines[0]).toMatch(/^console\.log\(x\d+\);$/);
  });

  it('proposes, records a timeout and goes on, and leaves every existing rule and its YAML as it was', async () => {
    // Live and shadow rules this workspace already has.
    await db.insert(security.ruleRegistry).values([
      {
        workspaceId: WS,
        ruleId: 'slop.live-rule',
        status: 'active',
        provenance: { source: 'experts:R-01', license: 'MIT', author: 'a', date: '2026-01-01' },
        shadowStartedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        workspaceId: WS,
        ruleId: 'slop.shadow-rule',
        status: 'candidate',
        provenance: { source: 'llm_draft', license: 'x', author: 'b', date: '2026-09-01' },
        shadowStartedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);
    await db.insert(security.ruleRegistry).values({
      workspaceId: OTHER,
      ruleId: 'slop.theirs',
      status: 'active',
      provenance: { source: 'experts:R-02', license: 'MIT', author: 'c', date: '2026-01-01' },
    });
    // Three noisy rules, by cluster size: A times out, B names a live rule, C is new.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await judged(WS, 'slop.rule-a', 'likely_false_positive'));
    for (let i = 0; i < 4; i++) ids.push(await judged(WS, 'slop.rule-b', 'likely_false_positive'));
    for (let i = 0; i < 3; i++) ids.push(await judged(WS, 'slop.rule-c', 'likely_false_positive'));
    ids.push(await judged(WS, 'slop.rule-c', 'real', { evidence: 'console.log(password)' }));
    // Another workspace's verdicts never reach this workspace's prompts.
    for (let i = 0; i < 4; i++)
      await judged(OTHER, 'slop.rule-d', 'likely_false_positive', { evidence: 'other-tenant' });

    const before = await registry(WS);
    const otherBefore = await registry(OTHER);
    const yamlBefore = hashTree(RULEPACKS_DIR);

    const gw = scripted({
      'slop.rule-a': 'throw',
      'slop.rule-b': draft('slop.live-rule', { status: 'active' }),
      'slop.rule-c': draft('slop.narrower-console', {
        status: 'active',
        provenance: { source: 'experts:R-09', license: 'MIT', author: 'x', date: '2020-01-01' },
      }),
    });
    const r = await runStoredVerdictTweakPass({
      db,
      workspaceId: WS,
      gateway: gw.gateway,
      now: NOW,
    });

    expect(r).toMatchObject({
      status: 'succeeded',
      clusters: 3,
      proposed: 1,
      collided: 1,
      rejected: 0,
      errors: 1,
    });
    expect(r.error).toMatch(/slop\.rule-a: .*300 s/);
    expect(gw.calls).toHaveLength(3);
    expect(gw.calls.every((c) => c.tier === 'T2' && c.meta.role === 'triage')).toBe(true);
    expect(gw.prompts.join('\n')).not.toContain('other-tenant');
    expect(gw.prompts.find((p) => p.includes('slop.rule-c'))).toContain('console.log(password)');

    // Existing rows: byte for byte the same, in both workspaces.
    const after = await registry(WS);
    for (const row of before) expect(after.find((a) => a.id === row.id)).toEqual(row);
    expect(await registry(OTHER)).toEqual(otherBefore);

    // The one new row is a PROPOSAL: not shadow-started, not live, our provenance.
    const added = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      workspaceId: WS,
      ruleId: 'slop.narrower-console',
      status: 'proposed',
      shadowStartedAt: null,
      fpRate: null,
      demotionCandidate: false,
      updatedBy: null,
    });
    expect(added[0]!.provenance).toMatchObject({
      source: 'llm_draft:ai_triage',
      author: 'analysis-gateway',
    });

    // Nothing on disk changed, and no finding was dismissed, resolved or suppressed.
    expect(hashTree(RULEPACKS_DIR)).toBe(yamlBefore);
    const fs = await db
      .select({ status: read.findings.status })
      .from(read.findings)
      .where(inArray(read.findings.id, ids));
    expect(fs.every((f) => f.status === 'open')).toBe(true);

    // A second week with the same verdicts proposes nothing new and changes nothing.
    const again = await runStoredVerdictTweakPass({
      db,
      workspaceId: WS,
      gateway: scripted({
        'slop.rule-a': draft('slop.shadow-rule'),
        'slop.rule-b': draft('slop.rule-a'),
        'slop.rule-c': draft('slop.narrower-console'),
      }).gateway,
      now: NOW,
    });
    expect(again).toMatchObject({ proposed: 0, collided: 3, errors: 0 });
    expect(await registry(WS)).toEqual(after);
  });

  it('skips by name with no gateway and touches nothing', async () => {
    for (let i = 0; i < 4; i++) await judged(WS, 'slop.rule-a', 'likely_false_positive');
    expect(await runStoredVerdictTweakPass({ db, workspaceId: WS, now: NOW })).toMatchObject({
      status: 'skipped',
      skippedReason: 'no_gateway',
    });
    expect(await registry(WS)).toEqual([]);
  });
});
