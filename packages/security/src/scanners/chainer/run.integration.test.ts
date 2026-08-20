import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { runChainer } from './run.js';
import { compoundFindings } from './compound.js';

// The chainer pass against the real store (W8-09, FR-SEC-8 / FR-INSIGHTS-6).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w8-09-fp';

describeIfLiveInfra('chainer pass (W8-09)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let runId = 0;
  let secretFindingId = 0;

  async function seedFinding(input: {
    dedupKey: string;
    dimension: string;
    severity: number;
    title: string;
    file: string | null;
    scannerKey: string;
    yields?: Record<string, unknown> | null;
    preconditions?: Record<string, unknown> | null;
  }): Promise<number> {
    const [row] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        scanRunId: runId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: input.dimension,
        severity: input.severity,
        confidence: 4,
        title: input.title,
        file: input.file,
        lineStart: input.file ? 1 : null,
        lineEnd: input.file ? 1 : null,
        evidence: `${input.title} evidence`,
        recommendation: 'fix it',
        tier: 1,
        dedupKey: input.dedupKey,
        status: 'open',
        scannerKey: input.scannerKey,
        yields: input.yields ?? null,
        preconditions: input.preconditions ?? null,
      })
      .returning();
    return row!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-09-user', forgeUserId: 'w8-09-user', login: 'w8-09-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-09-user' } })
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
        forgeRepoId: 'w8-09-repo',
        org: 'acme',
        name: 'chains',
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
        scannerKey: 'secrets',
        scannerVersion: 'secrets.v1',
        commitSha: 'w8-09-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    runId = run!.id;

    // The golden pair: a credential, and something that needs one.
    secretFindingId = await seedFinding({
      dedupKey: 'w8-09-secret',
      dimension: 'secrets',
      severity: 4,
      title: 'AWS credential committed',
      file: 'src/config.ts',
      scannerKey: 'secrets',
      yields: { 'credential:aws': true },
    });
    await seedFinding({
      dedupKey: 'w8-09-use',
      dimension: 'sast',
      severity: 3,
      title: 'Bucket read with ambient credentials',
      file: 'src/s3.ts',
      scannerKey: 'semgrep',
      preconditions: { 'credential:aws': true },
      yields: { 'data-read': true },
    });

    // A file flagged by three DIFFERENT dimensions — the compound case.
    await seedFinding({
      dedupKey: 'w8-09-compound-1',
      dimension: 'code_health',
      severity: 3,
      title: 'Function too complex',
      file: 'src/hot.ts',
      scannerKey: 'code_health_tools',
    });
    await seedFinding({
      dedupKey: 'w8-09-compound-2',
      dimension: 'sast',
      severity: 4,
      title: 'SQL built by concatenation',
      file: 'src/hot.ts',
      scannerKey: 'semgrep',
    });
    await seedFinding({
      dedupKey: 'w8-09-compound-3',
      dimension: 'performance',
      severity: 2,
      title: 'N+1 query',
      file: 'src/hot.ts',
      scannerKey: 'analysis',
    });
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('writes a chain finding with its member ids and a renderable graph', async () => {
    const result = await runChainer({ db, workspaceId, repoId, trigger: 'manual' });
    expect(result.status).toBe('succeeded');
    expect(result.chains).toBe(1);

    const [chain] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'chain')));

    expect(chain?.severity).toBe(5); // one above the worst member (4)
    // A chain spans findings and has no single location — picking one member's
    // file would send a reader to a step rather than to the path.
    expect(chain?.file).toBeNull();
    const payload = chain?.yields as { member_finding_ids?: number[]; nodes?: unknown[] };
    expect(payload.member_finding_ids).toContain(secretFindingId);
    // The graph the dashboard renders: every node references its finding, so
    // each step is checkable rather than a picture of an argument.
    expect(payload.nodes).toHaveLength(2);
  });

  it('finds the compound cluster: one file, three dimensions', async () => {
    const clusters = await compoundFindings(db, workspaceId, repoId);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.file).toBe('src/hot.ts');
    expect(clusters[0]?.dimensions).toEqual(['code_health', 'performance', 'sast']);
    // One above the worst member, same rule as a chain.
    expect(clusters[0]?.severity).toBe(5);

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'compound')));
    expect(row?.file).toBe('src/hot.ts');
  });

  it('two scanners of the SAME dimension are corroboration, not compounding', async () => {
    // Counting scanners rather than dimensions would make "we ran more
    // scanners" look like "this file got worse".
    await seedFinding({
      dedupKey: 'w8-09-same-dim-1',
      dimension: 'sast',
      severity: 3,
      title: 'first sast finding',
      file: 'src/corroborated.ts',
      scannerKey: 'semgrep',
    });
    await seedFinding({
      dedupKey: 'w8-09-same-dim-2',
      dimension: 'sast',
      severity: 3,
      title: 'second sast finding',
      file: 'src/corroborated.ts',
      scannerKey: 'owasp_web',
    });

    const clusters = await compoundFindings(db, workspaceId, repoId);
    expect(clusters.map((c) => c.file)).not.toContain('src/corroborated.ts');
  });

  it('re-running over unchanged findings creates ZERO new rows', async () => {
    const before = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const result = await runChainer({ db, workspaceId, repoId });
    expect(result.created).toBe(0);
    const after = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(after.length).toBe(before.length);
  });

  it('AUTO-RESOLVES the chain when a member is fixed, with an audit row', async () => {
    // The link-broken half. Nothing else would ever close a chain: the
    // ordinary stale sweep works on files, and a chain has none.
    await db
      .update(read.findings)
      .set({ status: 'resolved', statusChangedAt: new Date() })
      .where(eq(read.findings.id, secretFindingId));

    const result = await runChainer({ db, workspaceId, repoId });
    expect(result.autoResolved).toBeGreaterThanOrEqual(1);

    const [chain] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'chain')));
    expect(chain?.status).toBe('resolved');

    // "Why did this close" has to be answerable — a finding that vanishes
    // without a recorded reason is one nobody can defend.
    const events = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, chain!.id));
    expect(events.some((e) => e.reason?.includes('path no longer holds'))).toBe(true);
  });
});
