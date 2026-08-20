import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import { toIncoming } from './run.js';
import { ARCHITECTURE_SCANNER_KEY } from './tools.js';
import { detectArchitecture } from './graph.js';
import { loadArchitecturePack } from './pack.js';

// Storing architecture findings (W10-03, acceptance item 4).
//
// The claim under test is the DEDUP KEY: a second identical pass must not
// create a second copy of the same cycle, and two different cycles must not
// collapse into one.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w10-03-fp';

describeIfLiveInfra('architecture findings', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let scanRunId = 0;

  const graph = {
    edges: new Map<string, string[]>([
      ['src/a.ts', ['src/b.ts']],
      ['src/b.ts', ['src/a.ts']],
      ['src/c.ts', ['src/d.ts']],
      ['src/d.ts', ['src/c.ts']],
    ]),
    files: new Map<string, string>([
      ['src/a.ts', 'src/a.ts'],
      ['src/b.ts', 'src/b.ts'],
      ['src/c.ts', 'src/c.ts'],
      ['src/d.ts', 'src/d.ts'],
    ]),
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
      .values({ authProvider: 'github', authSubject: 'w10-03-user', forgeUserId: 'w10-03-user', login: 'w10-03-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w10-03-user' } })
      .returning();

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
        createdBy: user!.id,
      })
      .returning();

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w10-03-repo',
        org: 'acme',
        name: 'architecture',
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
        scannerKey: ARCHITECTURE_SCANNER_KEY,
        scannerVersion: 'dependency_cruiser@17.4.3',
        commitSha: 'w10-03-sha',
        trigger: 'schedule',
        status: 'running',
      })
      .returning();
    scanRunId = run!.id;
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w10-03-user'));
  });

  it('stores two distinct cycles as two findings', async () => {
    const findings = toIncoming(detectArchitecture(graph, loadArchitecturePack()).findings);
    const persisted = await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings,
      sweepDimensions: ['architecture'],
      sweepScannerKey: ARCHITECTURE_SCANNER_KEY,
    });

    expect(persisted.created).toBe(2);
    const rows = await db
      .select({ title: read.findings.title })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'architecture')));
    expect(rows).toHaveLength(2);
  });

  it('a second identical pass creates NOTHING new (canonical dedup key)', async () => {
    const findings = toIncoming(detectArchitecture(graph, loadArchitecturePack()).findings);
    const persisted = await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings,
      sweepDimensions: ['architecture'],
      sweepScannerKey: ARCHITECTURE_SCANNER_KEY,
    });

    expect(persisted.created).toBe(0);
    const rows = await db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'architecture')));
    expect(rows).toHaveLength(2);
  });
});
