import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { PERF_PACK_DIR, PERF_SCANNER_KEY, runPerfScan } from './run.js';
import { readRulepack } from '../semgrep/scanner.js';

// performance scanner (W9-13) — closing W9-08's fourth acceptance criterion.

const databaseUrl = process.env.DATABASE_URL;
const FP = 'w9-13-fp';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TRIGGERING = path.resolve(HERE, '../../../fixtures/perf/triggering/app.js');

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

// THE REGRESSION TEST, and it needs neither a database nor a sandbox — which
// matters, because the bug it pins survived a full green gate for a whole wave.
//
// W9-08 shipped eight rules that nothing loaded. `readRulepack` lists a
// directory and keeps the .yaml files; it does not recurse. The only runner
// pointed at `rulepacks/code-health/`, so it loaded the two .yaml files sitting
// there and never saw the `perf/` SUBDIRECTORY. Every existing test read the
// pack file straight off disk by path, so all of them passed while the product
// could not reach a single rule.
//
// This asserts the wiring instead of the file: whatever directory the scanner
// actually hands to the engine must be one the engine's own loader finds the
// perf rules in.
describe('the perf pack is reachable through the scanner (W9-13)', () => {
  it('points at a directory whose .yaml files readRulepack can see', () => {
    expect(existsSync(PERF_PACK_DIR)).toBe(true);
    const pack = readRulepack(PERF_PACK_DIR);
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.ruleIds.length).toBeGreaterThanOrEqual(8);
    for (const id of pack.ruleIds) expect(id.startsWith('bpm-perf-'), id).toBe(true);
  });

  it('is NOT reachable from the parent dir — the shape of the original bug', () => {
    // Pinned so nobody "simplifies" the scanner back to the parent directory:
    // from there the loader sees anti-slop and logging and no perf rule at all.
    const parent = readRulepack(path.resolve(PERF_PACK_DIR, '..'));
    expect(parent.ruleIds.some((id) => id.startsWith('bpm-perf-'))).toBe(false);
  });
});

const describeIfReady = databaseUrl && scanImage ? describe : describe.skip;

describeIfReady('performance scan (W9-13)', () => {
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
      .values({
        authProvider: 'github',
        authSubject: 'w9-13-user',
        forgeUserId: 'w9-13-user',
        login: 'w9-13-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-13-user' } })
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
        forgeRepoId: 'w9-13-repo',
        org: 'acme',
        name: 'perf',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // The real fixture in a production path, and the SAME bytes in a test path.
    // The second one must contribute nothing: a scanner that fires on test
    // fixtures is one people filter out wholesale, and then it is not catching
    // the handler either.
    const source = readFileSync(TRIGGERING, 'utf8');
    targetDir = mkdtempSync(path.join(tmpdir(), 'w9-13-tree-'));
    mkdirSync(path.join(targetDir, 'src'), { recursive: true });
    mkdirSync(path.join(targetDir, 'test'), { recursive: true });
    writeFileSync(path.join(targetDir, 'src', 'app.js'), source);
    writeFileSync(path.join(targetDir, 'test', 'app.test.js'), source);
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

  it('stores findings under dimension `performance` — W9-08 acceptance 4', async () => {
    const result = await runPerfScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w9-13-sha',
      targetDir,
      trigger: 'schedule',
      ...(scanImage ? { image: scanImage } : {}),
    });

    expect(result.status).toBe('succeeded');
    expect(result.deterministic).toBeGreaterThan(0);
    expect(result.findingsCreated).toBeGreaterThan(0);

    const stored = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(stored.length).toBeGreaterThan(0);

    // The whole point of the ticket: not that a rule matched, but that what it
    // produced is reachable through the dimension a user filters on.
    for (const finding of stored) {
      expect(finding.dimension).toBe('performance');
      expect(finding.scannerKey).toBe(PERF_SCANNER_KEY);
      expect(finding.ruleId?.startsWith('bpm-perf-'), finding.ruleId ?? '').toBe(true);
      // Capped with the pack: a perf shape is not exploitable, and a rule that
      // outranks a real vulnerability in a sorted list makes the list wrong.
      expect(finding.severity).toBeLessThanOrEqual(3);
    }

    // Every finding came from src/. The identical file under test/ contributes
    // nothing — and it is the ENGINE that drops it, not our filter: opengrep
    // ignores test paths before we ever see a finding, so `result.excluded` is
    // legitimately 0 here. The runner-level exclusion is a second net for what
    // the engine does pass through, which is why this asserts the outcome
    // (nothing from a test path is stored) rather than the mechanism.
    expect(stored.every((f) => f.file?.startsWith('src/'))).toBe(true);
    expect(stored.some((f) => f.file?.includes('test/'))).toBe(false);
  }, 600_000);

  it('reports a missing snapshot as skipped, not as a clean repository', async () => {
    const result = await runPerfScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w9-13-sha',
      trigger: 'schedule',
    });
    // Zero findings and "we never looked" are different facts. This suite is
    // the reason the result type has a `skipped` status at all.
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('no_snapshot');
    expect(result.scanRunId).toBeNull();
  });
});
