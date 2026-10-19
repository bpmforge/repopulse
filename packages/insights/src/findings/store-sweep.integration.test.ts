import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import {
  falsePositiveRate,
  persistFindings,
  type IncomingFinding,
  type PersistParams,
} from './store.js';

// The full-run sweep (W20-08, UX_TODO FND-48 / FND-58).
//
// Full scans used to pass only the files that still had findings as
// "reviewed", so the fix that cleaned the last finding out of a file never
// closed it, and repo-level findings (licenses, dependency health) had no file
// to review at all. `fullSweep` lets a full run close those, inside its own
// scanner scope, and keep open what it could not have re-checked.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w20-08-sweep-fp';
const KEY = 'w20_08_sweep';

function hit(
  file: string | null,
  ruleId = 'r.one',
  over: Partial<IncomingFinding> = {},
): IncomingFinding {
  return {
    dimension: 'code_health',
    severity: 3,
    confidence: 4,
    file,
    lineStart: file ? 3 : null,
    lineEnd: file ? 3 : null,
    title: `${ruleId} in ${file ?? 'repo'}`,
    evidenceQuote: `${file ?? 'repo'} — ${ruleId}`,
    rationale: 'Why it applies.',
    suggestedFix: 'Do the fix.',
    scannerKey: KEY,
    ruleId,
    yields: null,
    ...over,
  };
}

describeIfLiveInfra('persistFindings full-run sweep (W20-08)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let scanRunId = 0;
  let userId = 0;

  const run = (findings: IncomingFinding[], over: Partial<PersistParams> = {}) =>
    persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings,
      sweepScannerKey: KEY,
      ...over,
    });

  const statusOf = async (file: string | null, ruleId = 'r.one') => {
    const rows = await db
      .select({ status: read.findings.status, file: read.findings.file })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));
    return rows.find((r) => r.file === file)?.status;
  };

  /** Events reference findings, so they go first. */
  const clean = async () => {
    const ids = db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    await db.delete(read.findingEvents).where(inArray(read.findingEvents.findingId, ids));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
  };

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
        authSubject: 'w20-08-sweep',
        forgeUserId: 'w20-08-sweep',
        login: 'w20-08-sweep',
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: 'w20-08-sweep' },
      })
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
        forgeRepoId: 'w20-08-sweep-repo',
        org: 'acme',
        name: 'sweep',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
    const [scan] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: KEY,
        scannerVersion: 'w20-08',
        commitSha: 'w20-08-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    scanRunId = scan!.id;
  });

  beforeEach(clean);

  afterAll(async () => {
    // Every repo this file ever made, so a run that died half-way is cleaned too.
    const repos = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(eq(core.repos.forgeRepoId, 'w20-08-sweep-repo'));
    for (const r of repos) {
      repoId = r.id;
      await clean();
      await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, r.id));
      await db.delete(core.repos).where(eq(core.repos.id, r.id));
    }
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('closes the last finding of a now-clean file once the run reviews the whole tree', async () => {
    await run([hit('src/a.ts'), hit('src/b.ts')]);
    // Before W20-08: reviewed = the files that still have findings.
    await run([hit('src/b.ts')], { reviewedFiles: ['src/b.ts'] });
    expect(await statusOf('src/a.ts')).toBe('open');
    // A full run reviews every file it scanned.
    const r = await run([hit('src/b.ts')], {
      reviewedFiles: ['src/a.ts', 'src/b.ts'],
      fullSweep: { treeFiles: ['src/a.ts', 'src/b.ts'] },
    });
    expect(r.autoResolved).toBe(1);
    expect(await statusOf('src/a.ts')).toBe('resolved');
    expect(await statusOf('src/b.ts')).toBe('open');
  });

  it('closes a finding whose file is gone from the tree, and leaves an unread file alone', async () => {
    await run([hit('src/gone.ts'), hit('src/unread.ts')]);
    await run([], {
      reviewedFiles: [],
      fullSweep: { treeFiles: ['src/unread.ts', 'src/other.ts'] },
    });
    expect(await statusOf('src/gone.ts')).toBe('resolved');
    expect(await statusOf('src/unread.ts')).toBe('open');
  });

  it('an empty tree list closes nothing', async () => {
    await run([hit('src/a.ts')]);
    await run([], { reviewedFiles: [], fullSweep: { treeFiles: [] } });
    expect(await statusOf('src/a.ts')).toBe('open');
  });

  it('closes repo-level findings only when asked, and keeps open what it could not re-check', async () => {
    await run([hit(null, 'license.policy'), hit(null, 'eol.node')]);
    await run([], { reviewedFiles: [], fullSweep: { treeFiles: ['package.json'] } });
    expect(await statusOf(null, 'license.policy')).toBe('open');
    await run([], {
      reviewedFiles: [],
      fullSweep: {
        repoLevel: true,
        treeFiles: ['package.json'],
        keepOpen: (row) => (row.ruleId ?? '').startsWith('eol.'),
      },
    });
    expect(await statusOf(null, 'license.policy')).toBe('resolved');
    expect(await statusOf(null, 'eol.node')).toBe('open');
  });

  it('never sweeps without a scope: another scanner’s findings stay open', async () => {
    await run([hit('src/a.ts')]);
    await run([], {
      sweepScannerKey: null,
      reviewedFiles: [],
      fullSweep: { treeFiles: ['src/other.ts'], repoLevel: true },
    });
    expect(await statusOf('src/a.ts')).toBe('open');
  });

  it('an empty pass with no scanner key or dimensions closes nothing (W20-13)', async () => {
    await run([hit('src/a.ts'), hit('src/a.ts', 'r.two', { dimension: 'security' })]);
    const r = await run([], { sweepScannerKey: null, reviewedFiles: ['src/a.ts'] });
    expect(r.autoResolved).toBe(0);
    expect(await statusOf('src/a.ts')).toBe('open');
    expect(await statusOf('src/a.ts', 'r.two')).toBe('open');
    // Explicitly empty dimensions are no scope either.
    await run([], { sweepScannerKey: null, sweepDimensions: [], reviewedFiles: ['src/a.ts'] });
    expect(await statusOf('src/a.ts')).toBe('open');
  });

  it('divides false positives by what a person triaged, not every finding (W20-13, FND-71)', async () => {
    const before = await falsePositiveRate(db, workspaceId);
    await run([hit('src/a.ts'), hit('src/b.ts'), hit('src/c.ts')]);
    const untriaged = await falsePositiveRate(db, workspaceId);
    expect(untriaged.total - before.total).toBe(3);
    expect(untriaged.triaged).toBe(before.triaged);
    await db
      .update(read.findings)
      .set({ status: 'dismissed', dismissReason: 'false_positive' })
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.file, 'src/a.ts')));
    const after = await falsePositiveRate(db, workspaceId);
    expect(after.triaged - before.triaged).toBe(1);
    expect(after.dismissedFalsePositive - before.dismissedFalsePositive).toBe(1);
    if (before.triaged === 0) expect(after.rate).toBe(1);
  });

  it('keeps the rationale beside the fix (FND-57)', async () => {
    await run([hit('src/a.ts')]);
    const [row] = await db
      .select({ rationale: read.findings.rationale, recommendation: read.findings.recommendation })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    expect(row).toEqual({ rationale: 'Why it applies.', recommendation: 'Do the fix.' });
  });
});
