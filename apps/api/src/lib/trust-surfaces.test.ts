import 'dotenv/config';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { core, facts, read, security, createDb, type Database } from '@repopulse/shared';
import { registerBuiltinScanners } from '@repopulse/security';
import { rulePrecision, type BenchmarkSummary } from './rule-precision.js';
import { packLanguages, repoCoverageMap } from './coverage-map.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// Trust surfaces (W18-22).
//
// What matters is what these refuse to say: no precision where nothing was
// measured, no blended number from two different sources, and no empty list
// that could be read as "all clear" when there was no evidence to look at.

describe('packLanguages', () => {
  it('reads both YAML list forms, normalises aliases and ignores generic', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w18-22-packs-'));
    writeFileSync(
      path.join(dir, 'a.v1.yaml'),
      [
        'rules:',
        '  - id: bpm-a',
        '    languages: [js, typescript]',
        '  - id: bpm-b',
        '    languages:',
        '      - py',
        '      - "go"',
        '    message: x',
        '  - id: bpm-c',
        '    languages: [generic]',
      ].join('\n'),
    );
    writeFileSync(path.join(dir, 'notes.txt'), 'languages: [rust]');
    expect(packLanguages([dir, path.join(dir, 'absent')])).toEqual([
      { language: 'go', packs: ['a.v1.yaml'], rules: 1 },
      { language: 'javascript', packs: ['a.v1.yaml'], rules: 1 },
      { language: 'python', packs: ['a.v1.yaml'], rules: 1 },
      { language: 'typescript', packs: ['a.v1.yaml'], rules: 1 },
    ]);
  });

  it('finds the shipped packs (JavaScript and TypeScript at least)', () => {
    const languages = packLanguages().map((l) => l.language);
    expect(languages).toContain('javascript');
    expect(languages).toContain('typescript');
  });
});

describeIfDb('trust surfaces over the database (W18-22)', () => {
  let db: Database;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let connectionId: number;
  let otherConnectionId: number;
  let repoId: number;
  let otherRepoId: number;
  let identityId: number;

  const SUMMARY: BenchmarkSummary = {
    ticket: 'W18-17',
    engine: 'semgrep 1.0.0',
    excludedSuites: [{ suite: 'rule-fixtures', reason: 'r' }],
    rules: {
      'bpm-bench-only': {
        tp: 3,
        fp: 1,
        fn: 0,
        precision: 0.75,
        suites: ['changes'],
        engine: 'yaml',
      },
      'bpm-both': { tp: 1, fp: 1, fn: 2, precision: 0.5, suites: ['sampleco'], engine: 'yaml' },
    },
    cwes: [],
    publicSuites: [],
    measured: { date: null, commit: null },
  };

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    registerBuiltinScanners();
    const mkWorkspace = async (slug: string) => {
      const [ws] = await db
        .insert(core.workspaces)
        .values({ slug, name: slug })
        .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: slug } })
        .returning();
      return ws!.id;
    };
    workspaceId = await mkWorkspace('w18-22-a');
    otherWorkspaceId = await mkWorkspace('w18-22-b');

    const mkConnection = async (wsId: number, fp: string) => {
      const [c] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: wsId,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.alloc(8),
          credentialIv: Buffer.alloc(12),
          keyVersion: 1,
          credentialFingerprint: fp,
          status: 'active',
        })
        .returning();
      return c!.id;
    };
    connectionId = await mkConnection(workspaceId, 'w18-22-fp-a');
    otherConnectionId = await mkConnection(otherWorkspaceId, 'w18-22-fp-b');

    const mkRepo = async (wsId: number, connId: number, forgeRepoId: string) => {
      await db.delete(core.repos).where(eq(core.repos.forgeRepoId, forgeRepoId));
      const [r] = await db
        .insert(core.repos)
        .values({
          workspaceId: wsId,
          connectionId: connId,
          forgeRepoId,
          org: 'acme',
          name: forgeRepoId,
          defaultBranch: 'main',
          isPrivate: false,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      return r!.id;
    };
    repoId = await mkRepo(workspaceId, connectionId, 'w18-22-repo');
    otherRepoId = await mkRepo(otherWorkspaceId, otherConnectionId, 'w18-22-other');

    const [identity] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'w18-22-dev', displayName: 'W18-22' })
      .returning();
    identityId = identity!.id;
  });

  afterEach(async () => {
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(read.findings).where(eq(read.findings.workspaceId, ws));
      await db.delete(security.ruleRegistry).where(eq(security.ruleRegistry.workspaceId, ws));
      await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, ws));
      await db
        .delete(security.repoScannerConfig)
        .where(eq(security.repoScannerConfig.workspaceId, ws));
      await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, ws));
      await db.delete(facts.commits).where(eq(facts.commits.workspaceId, ws));
    }
  });

  afterAll(async () => {
    await db.delete(core.identities).where(eq(core.identities.id, identityId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, otherRepoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, otherConnectionId));
    await db.$client.end();
  });

  let seq = 0;
  async function addFinding(v: {
    ruleId: string;
    status?: string;
    dismissReason?: string | null;
    experimental?: boolean;
    workspace?: number;
    repo?: number;
  }): Promise<void> {
    seq += 1;
    // A scanner finding needs its run (findings_run_parent_check).
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: v.workspace ?? workspaceId,
        repoId: v.repo ?? repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'v',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
        finishedAt: new Date(),
      })
      .returning();
    await db.insert(read.findings).values({
      scanRunId: run!.id,
      workspaceId: v.workspace ?? workspaceId,
      repoId: v.repo ?? repoId,
      dimension: 'sast',
      severity: 3,
      confidence: 3,
      title: `finding ${seq}`,
      evidence: 'x',
      recommendation: 'y',
      tier: 1,
      dedupKey: `w18-22-${seq}`,
      status: v.status ?? 'open',
      dismissReason: v.dismissReason ?? null,
      ruleId: v.ruleId,
      scannerKey: 'semgrep',
      experimental: v.experimental ?? false,
    });
  }

  async function addPaths(paths: string[]): Promise<void> {
    const [commit] = await db
      .insert(facts.commits)
      .values({
        workspaceId,
        repoId,
        sha: `sha-${seq++}`,
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: new Date(),
        committedAt: new Date(),
        messageHead: 'm',
        isRevertHeuristic: false,
      })
      .returning();
    await db.insert(facts.commitFiles).values(
      paths.map((p) => ({
        workspaceId,
        repoId,
        commitId: commit!.id,
        path: p,
        additions: 1,
        deletions: 0,
        status: 'modified',
      })),
    );
  }

  describe('rulePrecision', () => {
    it('reports triage and benchmark side by side, never blended, with their sample sizes', async () => {
      await addFinding({ ruleId: 'bpm-both', status: 'confirmed' });
      await addFinding({ ruleId: 'bpm-both', status: 'confirmed' });
      await addFinding({ ruleId: 'bpm-both', status: 'confirmed' });
      await addFinding({
        ruleId: 'bpm-both',
        status: 'dismissed',
        dismissReason: 'false_positive',
      });
      await addFinding({ ruleId: 'bpm-both', status: 'open' });

      const report = await rulePrecision(db, workspaceId, { summary: SUMMARY });
      const both = report.rules.find((r) => r.ruleId === 'bpm-both')!;
      expect(both.findings).toBe(5);
      expect(both.triage).toEqual({ triaged: 4, falsePositives: 1, precision: 0.75 });
      expect(both.benchmark?.precision).toBe(0.5);
      expect(both.lifecycle).toBe('pack');
      expect(report.benchmark.engine).toBe('semgrep 1.0.0');
    });

    it('says nothing measured — null, not 0 or 100% — for an untriaged rule outside the corpus', async () => {
      await addFinding({ ruleId: 'bpm-fresh', status: 'open' });
      const [fresh] = (
        await rulePrecision(db, workspaceId, { ruleId: 'bpm-fresh', summary: SUMMARY })
      ).rules;
      expect(fresh!.triage.precision).toBeNull();
      expect(fresh!.benchmark).toBeNull();

      const [unknown] = (
        await rulePrecision(db, workspaceId, { ruleId: 'never-seen', summary: SUMMARY })
      ).rules;
      expect(unknown).toMatchObject({ findings: 0, benchmark: null, triage: { precision: null } });
    });

    it('takes lifecycle from the registry, the shipped shadow default, or observed shadow findings', async () => {
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId: 'slop.unused_export',
        status: 'active',
        provenance: { source: 'ours' },
      });
      await addFinding({ ruleId: 'bpm-new-shadow', experimental: true });
      const report = await rulePrecision(db, workspaceId, { summary: SUMMARY });
      const by = (id: string) => report.rules.find((r) => r.ruleId === id)!;
      expect(by('slop.unused_export')).toMatchObject({
        lifecycle: 'active',
        lifecycleSource: 'registry',
      });
      expect(by('slop.phantom_symbol')).toMatchObject({
        lifecycle: 'candidate',
        lifecycleSource: 'shipped default',
      });
      expect(by('bpm-new-shadow')).toMatchObject({
        lifecycle: 'candidate',
        lifecycleSource: 'observed shadow findings',
      });
      expect(by('bpm-bench-only').lifecycle).toBe('pack');
    });

    it('never reads another workspace’s dispositions (Law 5)', async () => {
      await addFinding({
        ruleId: 'bpm-tenant',
        status: 'dismissed',
        dismissReason: 'false_positive',
        workspace: otherWorkspaceId,
        repo: otherRepoId,
      });
      const [row] = (
        await rulePrecision(db, workspaceId, { ruleId: 'bpm-tenant', summary: SUMMARY })
      ).rules;
      expect(row!.triage).toEqual({ triaged: 0, falsePositives: 0, precision: null });
    });
  });

  describe('repoCoverageMap', () => {
    const PACKS = [
      { language: 'javascript', packs: ['bpm-baseline.v1.yaml'], rules: 10 },
      { language: 'python', packs: ['perf.v1.yaml'], rules: 1 },
    ];

    it('says "unknown" — not an empty all-clear — when there is no evidence', async () => {
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      expect(map.languages.evidence).toBe('unknown');
      expect(map.languages.checked).toMatch(/not known/);
      expect(map.skippedFiles.evidence).toBe('unknown');
      expect(map.skippedFiles.checked).toMatch(/not known/);
      // Nothing has run, so every enabled, built scanner is a gap.
      expect(map.scanners.items.some((s) => s.reason === 'never_run')).toBe(true);
      // The unsupported capabilities are always listed.
      expect(map.scanners.items.map((s) => s.key)).toEqual(
        expect.arrayContaining(['test_coverage']),
      );
      expect(map.shadowRules.items.map((r) => r.ruleId)).toContain('slop.unused_export');
    });

    it('lists languages present with no pack, and keeps the covered ones as the denominator', async () => {
      await addPaths(['src/a.ts', 'src/b.ts', 'cmd/main.go', 'cmd/util.go', 'app.py', 'README.md']);
      await addPaths(['cmd/main.go', 'lib/x.rs']);
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      expect(map.languages.evidence).toBe('known');
      expect(map.languages.items).toEqual([
        { language: 'go', files: 2 },
        { language: 'rust', files: 1 },
      ]);
      const ts = map.languages.present.find((l) => l.language === 'typescript')!;
      // TypeScript has no YAML pack in PACKS, but the fast lane reads it.
      expect(ts).toMatchObject({ files: 2, packs: [], fastLane: true });
    });

    it('reports a partial whole-tree read without inventing a count', async () => {
      await db.insert(security.scanRuns).values({
        workspaceId,
        repoId,
        scannerKey: 'anti_slop',
        scannerVersion: 'v',
        commitSha: 'abc',
        trigger: 'schedule',
        status: 'succeeded',
        partial: true,
        finishedAt: new Date(),
      });
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      expect(map.skippedFiles.evidence).toBe('known');
      expect(map.skippedFiles.items).toHaveLength(1);
      expect(map.skippedFiles.items[0]).toMatchObject({ partial: true, count: null });
    });

    it('a complete read is known-empty, with what was checked spelled out', async () => {
      await db.insert(security.scanRuns).values({
        workspaceId,
        repoId,
        scannerKey: 'anti_slop',
        scannerVersion: 'v',
        commitSha: 'abc',
        trigger: 'schedule',
        status: 'succeeded',
        finishedAt: new Date(),
      });
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      expect(map.skippedFiles).toMatchObject({ evidence: 'known', items: [] });
      expect(map.skippedFiles.checked).toMatch(/512 KB/);
    });

    it('names disabled and failed scanners', async () => {
      await db.insert(security.repoScannerConfig).values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        enabled: false,
      });
      await db.insert(security.scanRuns).values({
        workspaceId,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'v',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'failed',
      });
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      const reason = (key: string) => map.scanners.items.find((s) => s.key === key)?.reason;
      expect(reason('secrets')).toBe('disabled');
      expect(reason('semgrep')).toBe('last_run_failed');
    });

    it('lists shadow rules with their open shadow findings on this repo, and drops promoted ones', async () => {
      await db.insert(security.ruleRegistry).values([
        { workspaceId, ruleId: 'slop.phantom_symbol', status: 'active', provenance: {} },
        { workspaceId, ruleId: 'bpm-drafted', status: 'candidate', provenance: {} },
      ]);
      await addFinding({ ruleId: 'slop.unused_export', experimental: true });
      await addFinding({ ruleId: 'slop.unused_export', experimental: true });
      const map = (await repoCoverageMap(db, workspaceId, repoId, { packs: PACKS }))!;
      const ids = map.shadowRules.items.map((r) => r.ruleId);
      expect(ids).not.toContain('slop.phantom_symbol');
      expect(ids).toContain('bpm-drafted');
      expect(map.shadowRules.items[0]).toEqual({
        ruleId: 'slop.unused_export',
        source: 'shipped default',
        openShadowFindings: 2,
      });
    });

    it('returns null for another workspace’s repository (Law 5)', async () => {
      expect(await repoCoverageMap(db, workspaceId, otherRepoId, { packs: PACKS })).toBeNull();
    });
  });
});
