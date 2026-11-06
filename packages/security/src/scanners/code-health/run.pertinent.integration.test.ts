import 'dotenv/config';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { registerBuiltinScanners } from '../../catalogue.js';
import { runCodeHealthScan } from './run.js';
import type { CodeHealthFinding, ToolRunResult } from './tools.js';
import type { AdapterFinding } from './adapters/types.js';

// W27-01, "pertinent code only", against the REAL store: findings an earlier
// scan left on tests and vendored code must not linger open once the scanner
// stops reporting them. A full run lists the whole tree as reviewed, so a
// finding it no longer reports closes as no longer reported (outdated_diff),
// and the path rule closes it even when its adapter failed this time. The
// tools are a stand-in (the container is not what is under test).

const databaseUrl = process.env.DATABASE_URL;
const describeIfReady = databaseUrl ? describe : describe.skip;
const FP = 'w27-01-fp';

const FILES = [
  'src/server.go',
  'src/server_test.go',
  'vendor/acme/lib/y.go',
  'tests/test_api.py',
  'src/app.py',
  'build/Dockerfile',
];

function tree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'w27-01-tree-'));
  for (const rel of FILES) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), '// x\n');
  }
  return dir;
}

const ours = (ruleId: string, file: string): CodeHealthFinding => ({
  ruleId,
  file,
  lineStart: 1,
  lineEnd: 30,
  severity: 2,
  title: `${ruleId}: ${file}`,
  message: 'too much',
  measured: 30,
  threshold: 10,
});

const adapter = (tool: string, file: string): AdapterFinding => ({
  ruleId: `tool.${tool}.X1`,
  file,
  lineStart: 2,
  lineEnd: 2,
  severity: 2,
  title: `${tool} X1`,
  message: `${tool} says so`,
  dimension: 'code_health',
  nativeRule: 'X1',
});

function tools(
  findings: CodeHealthFinding[],
  adapterFindings: AdapterFinding[],
  adapterErrors: ToolRunResult['adapterErrors'] = [],
) {
  return (async (): Promise<ToolRunResult> => ({
    status: 'succeeded',
    findings,
    adapterFindings,
    adapterErrors,
    metrics: { ch_duplication_pct: 1, ch_complexity_p90: 4, ch_worst_fn_count: 0 },
    toolVersions: { lizard: '1.24.0', jscpd: '4.3.0', ruff: '0', hadolint: '0' },
  })) as never;
}

describeIfReady('code health: findings on non-production files close on rescan (W27-01)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  beforeAll(async () => {
    registerBuiltinScanners();
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
        authSubject: 'w27-01-user',
        forgeUserId: 'w27-01-user',
        login: 'w27-01-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w27-01-user' } })
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
        forgeRepoId: 'w27-01-repo',
        org: 'acme',
        name: 'pertinent',
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
    const ids = db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    await db.delete(read.findingEvents).where(inArray(read.findingEvents.findingId, ids));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('a full rescan closes what earlier runs left on tests and vendored code, and nothing else', async () => {
    const dir = tree();
    const run = (sha: string, runTools: never) =>
      runCodeHealthScan({
        db,
        provider: {} as ForgeProvider,
        workspaceId,
        repoId,
        repo: 'acme/pertinent',
        commitSha: sha,
        trigger: 'manual',
        snapshot: { dir, commitSha: sha },
        runTools,
      });

    // What a pre-W27-01 scan stored: complexity and clones in tests and vendor/.
    const before = await run(
      'w27-01-old',
      tools(
        [
          ours('complexity.cyclomatic', 'src/server.go'),
          ours('complexity.cyclomatic', 'src/server_test.go'),
          ours('duplication.clone', 'vendor/acme/lib/y.go'),
        ],
        [
          adapter('ruff', 'tests/test_api.py'),
          adapter('ruff', 'src/app.py'),
          adapter('hadolint', 'build/Dockerfile'),
        ],
      ),
    );
    expect(before.status, before.error ?? '').toBe('succeeded');

    // Today's scanner reports production code only; ruff failed this time.
    const after = await run(
      'w27-01-new',
      tools(
        [ours('complexity.cyclomatic', 'src/server.go')],
        [adapter('hadolint', 'build/Dockerfile')],
        [{ adapter: 'ruff', reason: 'produced no output' }],
      ),
    );
    expect(after.status, after.error ?? '').toBe('succeeded');

    const rows = await db
      .select()
      .from(read.findings)
      .where(
        and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'code_health_tools')),
      );
    const statusOf = (file: string) => rows.find((r) => r.file === file)?.status;
    expect(statusOf('src/server_test.go')).toBe('resolved');
    expect(statusOf('vendor/acme/lib/y.go')).toBe('resolved');
    // The path decides, even though ruff did not run this time...
    expect(statusOf('tests/test_api.py')).toBe('resolved');
    // ...while a production ruff finding waits for a run where ruff worked.
    expect(statusOf('src/app.py')).toBe('open');
    expect(statusOf('src/server.go')).toBe('open');
    // IaC adapters are not path-scoped: build/Dockerfile is the one that ships.
    expect(statusOf('build/Dockerfile')).toBe('open');

    // Closed as "no longer reported", by the rescan, not as fixed by anyone.
    const closed = rows.filter((r) => r.status === 'resolved').map((r) => r.id);
    const events = await db
      .select()
      .from(read.findingEvents)
      .where(inArray(read.findingEvents.findingId, closed));
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e).toMatchObject({
        fromStatus: 'open',
        toStatus: 'resolved',
        reason: 'outdated_diff',
        actor: null,
        scanRunId: after.scanRunId,
      });
    }
  });
});
