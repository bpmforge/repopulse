import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from './store.js';
import { pruneClosedFindingContext, findingContextRetentionDays } from './context.js';

// A finding keeps a few scanned lines (context), refreshed on each sighting and
// cleared a retention window after the finding closes.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w18-32-fp';

function finding(context?: IncomingFinding['context']): IncomingFinding {
  return {
    dimension: 'logging',
    severity: 2,
    confidence: 4,
    file: 'src/handler.js',
    lineStart: 12,
    lineEnd: 12,
    title: 'console.log in a request path',
    evidenceQuote: 'src/handler.js:12 — bpm-log-console-log',
    rationale: 'A console call in a request path.',
    suggestedFix: null,
    scannerKey: 'logging_hygiene',
    ruleId: 'bpm-log-console-log',
    yields: null,
    ...(context !== undefined ? { context } : {}),
  };
}

describeIfLiveInfra('stored finding context (W18-32)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let scanRunId = 0;
  let userId = 0;

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
        authSubject: 'w18-32-user',
        forgeUserId: 'w18-32-user',
        login: 'w18-32-user',
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: 'w18-32-user' },
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
        forgeRepoId: 'w18-32-repo',
        org: 'acme',
        name: 'ctx',
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
        scannerKey: 'logging_hygiene',
        scannerVersion: 'w18-32-test',
        commitSha: 'w18-32-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    scanRunId = run!.id;
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

  const params = (f: IncomingFinding[]) => ({
    workspaceId,
    repoId,
    scanRunId,
    pullRequestId: null,
    tier: 1,
    findings: f,
    sweepScannerKey: 'logging_hygiene',
  });
  const row = async () =>
    (await db.select().from(read.findings).where(eq(read.findings.repoId, repoId)))[0]!;

  it('stores the lines and their first line number', async () => {
    await persistFindings(db, params([finding({ startLine: 4, lines: 'a\nb\nc' })]));
    const r = await row();
    expect(r.contextLines).toBe('a\nb\nc');
    expect(r.contextStartLine).toBe(4);
  });

  it('a sighting that states no context leaves the stored lines alone', async () => {
    await persistFindings(db, params([finding()]));
    expect((await row()).contextLines).toBe('a\nb\nc');
  });

  it('a sighting with new lines replaces them; an explicit null clears them', async () => {
    await persistFindings(db, params([finding({ startLine: 5, lines: 'x' })]));
    expect((await row()).contextLines).toBe('x');
    expect((await row()).contextStartLine).toBe(5);
    await persistFindings(db, params([finding(null)]));
    expect((await row()).contextLines).toBeNull();
    expect((await row()).contextStartLine).toBeNull();
  });

  it('clears lines on findings closed past the window, and only those', async () => {
    await persistFindings(db, params([finding({ startLine: 1, lines: 'keep me' })]));
    const id = (await row()).id;
    const day = 24 * 60 * 60 * 1000;
    // Closed 100 days ago: past the 90-day default.
    await db
      .update(read.findings)
      .set({ status: 'dismissed', statusChangedAt: new Date(Date.now() - 100 * day) })
      .where(eq(read.findings.id, id));
    await pruneClosedFindingContext(db, { workspaceId, repoId, days: 90 });
    expect((await row()).contextLines).toBeNull();

    // Closed 10 days ago: kept. Open: kept.
    await db
      .update(read.findings)
      .set({
        contextLines: 'keep me',
        contextStartLine: 1,
        statusChangedAt: new Date(Date.now() - 10 * day),
      })
      .where(eq(read.findings.id, id));
    await pruneClosedFindingContext(db, { workspaceId, repoId, days: 90 });
    expect((await row()).contextLines).toBe('keep me');
    await db
      .update(read.findings)
      .set({ status: 'open', statusChangedAt: new Date(Date.now() - 400 * day) })
      .where(eq(read.findings.id, id));
    await pruneClosedFindingContext(db, { workspaceId, repoId, days: 90 });
    expect((await row()).contextLines).toBe('keep me');
  });
});

describe('findingContextRetentionDays', () => {
  it('defaults to 90, accepts 0 and whole numbers, and ignores junk', () => {
    expect(findingContextRetentionDays({})).toBe(90);
    expect(findingContextRetentionDays({ FINDING_CONTEXT_RETENTION_DAYS: '0' })).toBe(0);
    expect(findingContextRetentionDays({ FINDING_CONTEXT_RETENTION_DAYS: '30' })).toBe(30);
    expect(findingContextRetentionDays({ FINDING_CONTEXT_RETENTION_DAYS: 'x' })).toBe(90);
    expect(findingContextRetentionDays({ FINDING_CONTEXT_RETENTION_DAYS: '-5' })).toBe(90);
  });
});
