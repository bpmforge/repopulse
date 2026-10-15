import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import { ANTI_SLOP_SCANNER_KEY, runAntiSlopScan } from './run.js';
import {
  ANTI_SLOP_PACK_FILE_PREFIX,
  CODE_HEALTH_PACK_DIR,
  LOGGING_PACK_FILE_PREFIX,
  LOGGING_SCANNER_KEY,
  runLoggingScan,
} from '../logging/run.js';
import { readRulepack, type SemgrepRunArgs, type SemgrepRunResult } from '../semgrep/scanner.js';
import { parseOpengrepOutput } from '../semgrep/output.js';

// W18-30: the anti-slop half of the W9-01 pack never surfaced.
//
// `rulepacks/code-health/` holds anti-slop.v1.yaml and logging.v1.yaml. The
// only runner that loaded it was the LOGGING scanner, which kept `bpm-log-*`
// and dropped the rest by id; the anti_slop scanner ran LDR and docstring
// arithmetic and never touched the pack. So eight `bpm-ch-*` rules were
// evaluated on every weekly run and stored by nobody, while the Code Health
// tab filtered on `bpm-ch-` for findings that could not exist.
//
// The scanners' PackRunner is handed a recorded engine run (see RECORDED), so
// the wiring is tested on every machine, not only those with the scan image.

const databaseUrl = process.env.DATABASE_URL;
const FP = 'w18-30-fp';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The tree the recording was made from. The recorded paths are under src/,
// as in a real repository: the runners drop anything under fixtures/, which
// would make this test vacuous if the paths pointed there.
const TRIGGERING = path.resolve(HERE, '../../../fixtures/code-health/triggering');

const ANTI_SLOP_RULE_IDS = [
  'bpm-ch-emoji-comment',
  'bpm-ch-empty-catch',
  'bpm-ch-prose-padding',
  'bpm-ch-silent-fallback-return',
  'bpm-ch-step-narration',
  'bpm-ch-stub-as-feature',
  'bpm-ch-try-catch-in-loop',
  'bpm-ch-what-comment',
];

/**
 * The real engine's output over the triggering fixtures, recorded.
 *
 * Recorded rather than spawned: arch rule 7 (NFR-14) forbids starting a scan
 * tool outside the sandbox anywhere under src/, tests included, and the
 * sandbox needs the scan image — every test that needed it skipped on machines
 * without one, which is how this whole-pack wiring bug survived green gates.
 * The recording is the full code-health pack (anti-slop + logging) run by
 * semgrep 1.181 over the two triggering files placed under src/; the runner
 * below hands back only the results for the rules the caller actually loaded,
 * which is the part of the engine's contract this bug lives in. That the
 * rules themselves still fire is pack.test.ts's golden set.
 */
const RECORDED = readFileSync(
  path.resolve(HERE, '../../../fixtures/code-health/recorded/triggering.opengrep.json'),
  'utf8',
);

/** Every pack load, by the files it was asked to load. */
const loads: string[][] = [];

/** The runSemgrepScan contract, answered from the recording. */
async function recordedPackRunner(args: SemgrepRunArgs): Promise<SemgrepRunResult> {
  const pack = readRulepack(args.rulepackDir ?? CODE_HEALTH_PACK_DIR, args.rulepackFiles);
  loads.push(pack.files);
  const parsed = parseOpengrepOutput({ stdout: RECORDED, knownRuleIds: pack.ruleIds });
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    status: 'succeeded',
    // An engine reports only rules it loaded.
    findings: parsed.findings.filter((f) => pack.ruleIds.includes(f.ruleId)),
    toolErrors: parsed.toolErrors,
    durationMs: 0,
    toolVersions: { opengrep: 'recorded', rulepack: pack.version },
  };
}

describe('the code-health pack is split between its two scanners (W18-30)', () => {
  const files = readdirSync(CODE_HEALTH_PACK_DIR).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
  );

  it('every pack file is claimed by exactly one scanner', () => {
    // A file neither prefix claims is a file of rules nothing runs — the W9-13
    // and W18-30 bug, a third time. A file both claim double-reports.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const owners = [ANTI_SLOP_PACK_FILE_PREFIX, LOGGING_PACK_FILE_PREFIX].filter((p) =>
        file.startsWith(p),
      );
      expect(owners, file).toHaveLength(1);
    }
  });

  it('each side holds only its own rule ids', () => {
    const slop = readRulepack(CODE_HEALTH_PACK_DIR, (f) =>
      f.startsWith(ANTI_SLOP_PACK_FILE_PREFIX),
    );
    const logging = readRulepack(CODE_HEALTH_PACK_DIR, (f) =>
      f.startsWith(LOGGING_PACK_FILE_PREFIX),
    );
    expect(slop.ruleIds.length).toBeGreaterThanOrEqual(ANTI_SLOP_RULE_IDS.length);
    for (const id of ANTI_SLOP_RULE_IDS) expect(slop.ruleIds).toContain(id);
    for (const id of slop.ruleIds) expect(id.startsWith('bpm-ch-'), id).toBe(true);
    expect(logging.ruleIds.length).toBeGreaterThan(0);
    for (const id of logging.ruleIds) expect(id.startsWith('bpm-log-'), id).toBe(true);
  });
});

const describeIfReady = databaseUrl ? describe : describe.skip;

describeIfReady('bpm-ch-* findings reach the store (W18-30)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;

  async function newRepo(name: string): Promise<number> {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `w18-30-${name}`,
        org: 'acme',
        name: `w18-30-${name}`,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    return repo!.id;
  }

  /** What the weekly anti_slop runner does on one snapshot, minus the model. */
  async function snapshotPass(repoId: number, commitSha: string) {
    const slop = await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha,
      files: [],
      sources: [],
      targetDir: TRIGGERING,
      runPack: recordedPackRunner,
      trigger: 'schedule',
    });
    const logging = await runLoggingScan({
      db,
      workspaceId,
      repoId,
      commitSha,
      files: [],
      targetDir: TRIGGERING,
      runPack: recordedPackRunner,
      trigger: 'schedule',
    });
    return { slop, logging };
  }

  async function rowsOf(repoId: number) {
    return db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    await cleanup();

    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w18-30-user',
        forgeUserId: 'w18-30-user',
        login: 'w18-30-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-30-user' } })
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
    connectionId = conn!.id;
  });

  /**
   * Everything under this file's connection fingerprint, including what an
   * interrupted earlier run left behind: a stale repo on an old connection is
   * what makes the connection delete fail on the next run.
   */
  async function cleanup(): Promise<void> {
    const conns = (
      await db
        .select({ id: core.forgeConnections.id })
        .from(core.forgeConnections)
        .where(eq(core.forgeConnections.credentialFingerprint, FP))
    ).map((c) => c.id);
    if (conns.length === 0) return;
    const repos = (
      await db
        .select({ id: core.repos.id })
        .from(core.repos)
        .where(inArray(core.repos.connectionId, conns))
    ).map((r) => r.id);
    if (repos.length > 0) {
      const ids = (
        await db
          .select({ id: read.findings.id })
          .from(read.findings)
          .where(inArray(read.findings.repoId, repos))
      ).map((r) => r.id);
      if (ids.length > 0) {
        await db.delete(read.findingEvents).where(inArray(read.findingEvents.findingId, ids));
      }
      await db.delete(read.findings).where(inArray(read.findings.repoId, repos));
      await db.delete(security.scanRuns).where(inArray(security.scanRuns.repoId, repos));
      await db.delete(core.repos).where(inArray(core.repos.id, repos));
    }
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, conns));
  }

  afterAll(async () => {
    await cleanup();
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('the snapshot pass stores all eight bpm-ch-* rules as slop under anti_slop', async () => {
    // RED before W18-30: the triggering fixture fires every rule, and zero
    // bpm-ch-* rows reached the store.
    const repoId = await newRepo('stored');
    loads.length = 0;
    const { slop, logging } = await snapshotPass(repoId, 'w18-30-sha');
    expect(slop.status, slop.error ?? '').toBe('succeeded');

    const rows = await rowsOf(repoId);
    const ch = rows.filter((r) => r.ruleId?.startsWith('bpm-ch-'));
    expect([...new Set(ch.map((r) => r.ruleId))].sort()).toEqual(ANTI_SLOP_RULE_IDS);
    for (const row of ch) {
      expect(row.dimension, row.ruleId ?? '').toBe('slop');
      expect(row.scannerKey, row.ruleId ?? '').toBe(ANTI_SLOP_SCANNER_KEY);
      expect(row.severity).toBeLessThanOrEqual(3);
    }
    expect(slop.pack).toBe(ch.length);

    // The logging half is unchanged: still stored, still its own.
    expect(logging.status, logging.error ?? '').toBe('succeeded');
    const log = rows.filter((r) => r.ruleId?.startsWith('bpm-log-'));
    expect(log.length).toBeGreaterThan(0);
    for (const row of log) {
      expect(row.dimension).toBe('logging');
      expect(row.scannerKey).toBe(LOGGING_SCANNER_KEY);
    }

    // Each scanner loaded only its own files, so no rule was evaluated twice.
    expect(loads).toHaveLength(2);
    expect(loads[0]!.every((f) => f.startsWith(ANTI_SLOP_PACK_FILE_PREFIX))).toBe(true);
    expect(loads[1]!.every((f) => f.startsWith(LOGGING_PACK_FILE_PREFIX))).toBe(true);

    // The run is reproducible: it records which pack files produced it.
    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, slop.scanRunId!));
    expect(run?.toolVersions?.rulepack).toContain('anti-slop.v1.yaml');
  }, 300_000);

  it('a re-run on the same snapshot creates nothing new', async () => {
    const repoId = await newRepo('rerun');
    await snapshotPass(repoId, 'w18-30-a');
    const before = (await rowsOf(repoId)).length;
    const again = await snapshotPass(repoId, 'w18-30-b');
    expect(again.slop.findingsCreated).toBe(0);
    expect((await rowsOf(repoId)).length).toBe(before);
  }, 300_000);

  // The sweep is scoped by scanner key (store.ts). With the anti-slop
  // findings under anti_slop rather than logging_hygiene, a logging pass that
  // has reviewed every file closes only logging findings — and the reverse.
  async function sweepAs(repoId: number, scannerKey: string) {
    const files = [
      ...new Set((await rowsOf(repoId)).map((r) => r.file).filter((f): f is string => !!f)),
    ];
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey,
        scannerVersion: 'sweep',
        commitSha: 'w18-30-sweep',
        trigger: 'schedule',
        status: 'running',
      })
      .returning();
    return persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId: run!.id,
      pullRequestId: null,
      tier: 2,
      findings: [],
      reviewedFiles: files,
      sweepScannerKey: scannerKey,
    });
  }

  async function openCount(repoId: number, prefix: string): Promise<number> {
    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), inArray(read.findings.status, ['open'])));
    return rows.filter((r) => r.ruleId?.startsWith(prefix)).length;
  }

  it("the logging scanner's sweep never closes anti-slop findings", async () => {
    const repoId = await newRepo('sweep-logging');
    await snapshotPass(repoId, 'w18-30-s1');
    const ch = await openCount(repoId, 'bpm-ch-');
    expect(ch).toBeGreaterThan(0);

    const swept = await sweepAs(repoId, LOGGING_SCANNER_KEY);
    // The sweep did run — it closed the logging findings it owns...
    expect(swept.autoResolved).toBeGreaterThan(0);
    expect(await openCount(repoId, 'bpm-log-')).toBe(0);
    // ...and nothing of anti_slop's.
    expect(await openCount(repoId, 'bpm-ch-')).toBe(ch);
  }, 300_000);

  it("the anti_slop scanner's sweep never closes logging findings", async () => {
    const repoId = await newRepo('sweep-slop');
    await snapshotPass(repoId, 'w18-30-s2');
    const log = await openCount(repoId, 'bpm-log-');
    expect(log).toBeGreaterThan(0);

    const swept = await sweepAs(repoId, ANTI_SLOP_SCANNER_KEY);
    expect(swept.autoResolved).toBeGreaterThan(0);
    expect(await openCount(repoId, 'bpm-ch-')).toBe(0);
    expect(await openCount(repoId, 'bpm-log-')).toBe(log);
  }, 300_000);
});
