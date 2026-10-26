import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import { persistFindings, recordVerdicts, type IncomingFinding } from './store.js';

// W21-03: a second model's verdict on a stored finding. It MARKS the finding
// (verify_status, who, when, why); it never changes the finding's status, and a
// later run that could not ask does not erase an earlier answer.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w21-03-store-fp';

const finding = (over: Partial<IncomingFinding> = {}): IncomingFinding => ({
  dimension: 'slop',
  severity: 3,
  confidence: 4,
  file: 'src/a.ts',
  lineStart: 4,
  lineEnd: 6,
  title: 'A wrapper that only forwards',
  evidenceQuote: 'return inner(x);',
  rationale: 'It adds nothing.',
  suggestedFix: null,
  scannerKey: 'anti_slop',
  ruleId: 'slop.judgment',
  yields: null,
  ...over,
});

describeIfLiveInfra('second-model verdicts on findings (W21-03)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let otherWorkspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let scanRunId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w21-03-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w21-03-user',
        forgeUserId: 'w21-03-user',
        login: 'w21-03-user',
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: 'w21-03-user' },
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
        forgeRepoId: 'w21-03-repo',
        org: 'acme',
        name: 'verify',
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
        scannerKey: 'anti_slop',
        scannerVersion: 'w21-03-test',
        commitSha: 'w21-03-sha',
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
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    await db.$client.end();
  });

  const rowFor = async (title: string) =>
    (await db.select().from(read.findings).where(eq(read.findings.title, title)))[0]!;

  it('a contradicted finding is stored open, with who, when and why', async () => {
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 2,
      findings: [
        finding({
          title: 'contradicted one',
          verify: {
            status: 'contradicted',
            model: 'judge-b',
            providerId: null,
            connection: 'Box B',
            reason: 'the wrapper adds a retry',
          },
        }),
      ],
    });
    const row = await rowFor('contradicted one');
    expect(row).toMatchObject({
      status: 'open',
      verifyStatus: 'contradicted',
      verifiedByModel: 'judge-b',
      verifiedByConnection: 'Box B',
      verifyReason: 'the wrapper adds a retry',
    });
    expect(row.verifiedAt).toBeInstanceOf(Date);
  });

  it('a later run that could not ask keeps the earlier verdict', async () => {
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 2,
      findings: [
        finding({
          title: 'contradicted one',
          verify: {
            status: 'unverified',
            model: null,
            providerId: null,
            connection: null,
            reason: 'AI is off',
          },
        }),
      ],
    });
    const row = await rowFor('contradicted one');
    expect(row.verifyStatus).toBe('contradicted');
    expect(row.verifyReason).toBe('the wrapper adds a retry');
  });

  it('recordVerdicts marks by dedup key, workspace-filtered, never touching status', async () => {
    const f = finding({ title: 'later verdict', file: 'src/b.ts', evidenceQuote: 'b();' });
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 2,
      findings: [f],
    });
    const key = dedupKey({
      dimension: f.dimension,
      file: f.file,
      evidenceQuote: f.evidenceQuote,
      lineStart: f.lineStart,
      scannerKey: f.scannerKey ?? null,
      ruleId: f.ruleId ?? null,
    });
    const verify = {
      status: 'confirmed' as const,
      model: 'judge-c',
      providerId: null,
      connection: 'Box C',
      reason: 'holds',
    };

    // Another workspace's call touches nothing here (Law 5).
    expect(
      await recordVerdicts(db, {
        workspaceId: otherWorkspaceId,
        repoId,
        verdicts: [{ dedupKey: key, verify }],
      }),
    ).toEqual({ recorded: 0 });
    expect((await rowFor('later verdict')).verifyStatus).toBe('unverified');

    expect(
      await recordVerdicts(db, { workspaceId, repoId, verdicts: [{ dedupKey: key, verify }] }),
    ).toEqual({ recorded: 1 });
    const row = await rowFor('later verdict');
    expect(row).toMatchObject({
      status: 'open',
      verifyStatus: 'confirmed',
      verifiedByModel: 'judge-c',
    });

    // An 'unverified' outcome over a real verdict changes nothing.
    await recordVerdicts(db, {
      workspaceId,
      repoId,
      verdicts: [
        {
          dedupKey: key,
          verify: {
            status: 'unverified',
            model: null,
            providerId: null,
            connection: null,
            reason: 'cap',
          },
        },
      ],
    });
    expect((await rowFor('later verdict')).verifyReason).toBe('holds');
  });
});
