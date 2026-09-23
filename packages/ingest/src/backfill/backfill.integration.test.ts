import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import {
  ForgeBudgetParkedError,
  type CallCtx,
  type ForgeProvider,
  type Page,
  type SinceQuery,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEntityPages } from './backfill.js';
import { enrichCommitChurn } from './enrich.js';
import { readCursor } from './cursor.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// ---- fake provider: deterministic pages keyed by cursor -------------------
type Pages<T> = Record<string, Page<T>>; // '' = first page

function pagedProvider(overrides: Record<string, unknown>): ForgeProvider {
  return overrides as unknown as ForgeProvider;
}

// The 3rd arg is a SinceQuery (prs/commits/issues) or a bare cursor string
// (releases/deployments) — resolve the cursor from either shape.
function pageFn<T>(pages: Pages<T>) {
  return (_ctx: CallCtx, _repo: string, q?: SinceQuery | string): Promise<Page<T>> => {
    const cursor = typeof q === 'string' ? q : q?.cursor;
    const key = cursor ?? '';
    const page = pages[key];
    if (!page) throw new Error(`fake: no page for cursor ${key}`);
    return Promise.resolve(page);
  };
}

const commitPages = {
  '': {
    items: [
      {
        sha: 'c1',
        authorLogin: 'alice',
        authorEmail: 'alice@x.com',
        authoredAt: '2026-01-01T00:00:00Z',
        committedAt: '2026-01-01T00:00:00Z',
        message: 'feat',
        parentShas: ['p1'],
      },
      {
        sha: 'c2',
        authorLogin: null,
        authorEmail: 'bob@x.com',
        authoredAt: '2026-01-02T00:00:00Z',
        committedAt: '2026-01-02T00:00:00Z',
        message: 'fix',
        parentShas: ['p2'],
      },
    ],
    nextCursor: '2',
  },
  '2': {
    items: [
      {
        sha: 'c3',
        authorLogin: 'alice',
        authorEmail: 'alice@x.com',
        authoredAt: '2026-01-03T00:00:00Z',
        committedAt: '2026-01-03T00:00:00Z',
        message: 'Revert feat',
        parentShas: ['p3'],
      },
    ],
  },
} as unknown as Pages<never>;

describeIfLiveInfra('backfill entity ingest (W2-03, FR-INGEST-2/3/4)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;

  async function makeRepo(forgeRepoId: string): Promise<number> {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId,
        org: 'acme',
        name: forgeRepoId,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
      })
      .returning();
    if (!repo) throw new Error('repo insert failed');
    return repo.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-03-backfill', name: 'w2-03-backfill' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-03-backfill' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w2-03-user', forgeUserId: 'w2-03-user', login: 'w2-03-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-03-user' } })
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
        credentialFingerprint: 'w2-03-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
  });

  afterAll(async () => {
    // FK order: facts → cursors → repos → connection → identities → user → ws
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(facts.issues).where(eq(facts.issues.workspaceId, workspaceId));
    await db.delete(facts.releases).where(eq(facts.releases.workspaceId, workspaceId));
    await db.delete(facts.deployments).where(eq(facts.deployments.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    // By workspace, not this run's id: an interrupted earlier run leaves its connection
    // behind, and the workspace delete below then fails on the FK.
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-03-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  async function commitCount(repoId: number): Promise<number> {
    const rows = await db.select().from(facts.commits).where(eq(facts.commits.repoId, repoId));
    return rows.length;
  }

  it('backfills all pages, matches ground-truth counts, and marks the cursor done', async () => {
    const repoId = await makeRepo('r-full');
    const provider = pagedProvider({ listCommits: pageFn(commitPages) });
    const result = await ingestEntityPages(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/r-full', entityType: 'commits' },
    );
    expect(result).toMatchObject({ pages: 2, itemsTotal: 3, done: true });
    expect(await commitCount(repoId)).toBe(3);

    const cursor = await readCursor(db, repoId, 'commits');
    expect(cursor?.backfillDone).toBe(true);

    // is_revert_heuristic caught the "Revert feat" commit
    const reverts = await db
      .select()
      .from(facts.commits)
      .where(and(eq(facts.commits.repoId, repoId), eq(facts.commits.isRevertHeuristic, true)));
    expect(reverts).toHaveLength(1);
  });

  it('creates an email:{address} fallback identity for a null-login commit (DATABASE §2 note 4)', async () => {
    const [fallback] = await db
      .select()
      .from(core.identities)
      .where(
        and(
          eq(core.identities.workspaceId, workspaceId),
          eq(core.identities.forgeLogin, 'email:bob@x.com'),
        ),
      );
    expect(fallback, 'email-only commit got a fallback identity').toBeTruthy();
  });

  it('is idempotent — re-running the backfill produces no duplicate rows', async () => {
    const repoId = await makeRepo('r-idem');
    const provider = pagedProvider({ listCommits: pageFn(commitPages) });
    const params = { workspaceId, repoId, repo: 'acme/r-idem', entityType: 'commits' as const };
    await ingestEntityPages({ db, provider }, params);
    await ingestEntityPages({ db, provider }, params); // second run
    expect(await commitCount(repoId)).toBe(3); // still 3, not 6
  });

  it('resumes from the per-page cursor after an interrupted job (no dupes, reaches completion)', async () => {
    const repoId = await makeRepo('r-resume');
    const provider = pagedProvider({ listCommits: pageFn(commitPages) });
    // maxPagesPerJob=1 simulates a job that yields after one page (or a crash).
    const first = await ingestEntityPages(
      { db, provider, maxPagesPerJob: 1 },
      { workspaceId, repoId, repo: 'acme/r-resume', entityType: 'commits' },
    );
    expect(first).toMatchObject({ done: false, nextCursor: '2' });
    expect(await commitCount(repoId)).toBe(2);

    // Resume from the checkpointed cursor.
    const resumed = await ingestEntityPages(
      { db, provider, maxPagesPerJob: 1 },
      {
        workspaceId,
        repoId,
        repo: 'acme/r-resume',
        entityType: 'commits',
        cursor: first.nextCursor!,
      },
    );
    expect(resumed.done).toBe(true);
    expect(await commitCount(repoId)).toBe(3); // 2 + 1, no re-do of page 1
  });

  it('yields on the budget floor without writing rows, reporting a resume cursor + reset', async () => {
    const repoId = await makeRepo('r-budget');
    const provider = pagedProvider({
      listCommits: () =>
        Promise.reject(new ForgeBudgetParkedError('backfill', 'primary-floor', 1_700_000_000)),
    });
    const result = await ingestEntityPages(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/r-budget', entityType: 'commits' },
    );
    expect(result).toMatchObject({ done: false, pages: 0, parkedUntilMs: 1_700_000_000 });
    expect(await commitCount(repoId)).toBe(0); // parked before any write
  });

  it('backfills PRs / issues / releases / deployments with matching counts', async () => {
    const repoId = await makeRepo('r-multi');
    const provider = pagedProvider({
      listPullRequests: pageFn({
        '': {
          items: [
            {
              number: 1,
              externalId: 'PR1',
              title: 't',
              body: null,
              authorLogin: 'alice',
              isBot: false,
              isDraft: false,
              state: 'merged',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-02T00:00:00Z',
              mergedAt: '2026-01-02T00:00:00Z',
              closedAt: '2026-01-02T00:00:00Z',
              mergedByLogin: 'bob',
              baseRef: 'main',
              headSha: 'h',
              additions: 1,
              deletions: 0,
              changedFiles: 1,
            },
          ],
        },
      } as unknown as Pages<never>),
      listIssues: pageFn({
        '': {
          items: [
            {
              externalId: 'I1',
              number: 4,
              title: 'bug',
              authorLogin: 'alice',
              state: 'open',
              createdAt: '2026-01-01T00:00:00Z',
              closedAt: null,
              isPullRequest: false,
            },
          ],
        },
      } as unknown as Pages<never>),
      listReleases: pageFn({
        '': {
          items: [
            {
              externalId: 'R1',
              tagName: 'v1',
              name: 'v1',
              isDraft: false,
              isPrerelease: false,
              publishedAt: '2026-01-01T00:00:00Z',
            },
          ],
        },
      } as unknown as Pages<never>),
      listDeployments: pageFn({
        '': {
          items: [
            {
              externalId: 'D1',
              sha: 's',
              environment: 'prod',
              createdAt: '2026-01-01T00:00:00Z',
              latestStatus: null,
            },
          ],
        },
      } as unknown as Pages<never>),
    });
    const base = { workspaceId, repoId, repo: 'acme/r-multi' };
    for (const entityType of ['prs', 'issues', 'releases', 'deployments'] as const) {
      const r = await ingestEntityPages({ db, provider }, { ...base, entityType });
      expect(r, entityType).toMatchObject({ itemsTotal: 1, done: true });
    }
    const prs = await db
      .select()
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.repoId, repoId));
    const deps = await db
      .select()
      .from(facts.deployments)
      .where(eq(facts.deployments.repoId, repoId));
    expect(prs).toHaveLength(1);
    expect(deps[0]?.latestStatus).toBe('pending'); // null domain status → 'pending'
  });

  it('yields after exactly maxPagesPerJob pages (≤20 default), then resumes for the rest', async () => {
    const repoId = await makeRepo('r-yield');
    // 25 single-item pages: '' → '1' → … → '24' (last, no nextCursor).
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      const key = i === 0 ? '' : String(i);
      pages[key] = {
        items: [
          {
            sha: `s${i}`,
            authorLogin: 'alice',
            authorEmail: 'a@x.com',
            authoredAt: '2026-01-01T00:00:00Z',
            committedAt: '2026-01-01T00:00:00Z',
            message: 'm',
            parentShas: [],
          },
        ],
        ...(i < 24 ? { nextCursor: String(i + 1) } : {}),
      };
    }
    const provider = pagedProvider({ listCommits: pageFn(pages as Pages<never>) });
    const base = { workspaceId, repoId, repo: 'acme/r-yield', entityType: 'commits' as const };

    const first = await ingestEntityPages({ db, provider }, base);
    expect(first).toMatchObject({ pages: 20, done: false }); // yielded at the cap
    expect(await commitCount(repoId)).toBe(20);

    const rest = await ingestEntityPages({ db, provider }, { ...base, cursor: first.nextCursor! });
    expect(rest).toMatchObject({ pages: 5, done: true });
    expect(await commitCount(repoId)).toBe(25); // no gap, no dupe across the yield
  });

  it('enrichment fills commit_files and rolls churn totals onto the commit', async () => {
    const repoId = await makeRepo('r-enrich');
    // Seed the commit first (enrichment needs its DB id).
    await ingestEntityPages(
      {
        db,
        provider: pagedProvider({
          listCommits: pageFn({
            '': {
              items: [
                {
                  sha: 'ec1',
                  authorLogin: 'alice',
                  authorEmail: 'a@x.com',
                  authoredAt: '2026-01-01T00:00:00Z',
                  committedAt: '2026-01-01T00:00:00Z',
                  message: 'm',
                  parentShas: [],
                },
              ],
            },
          } as unknown as Pages<never>),
        }),
      },
      { workspaceId, repoId, repo: 'acme/r-enrich', entityType: 'commits' },
    );

    const provider = pagedProvider({
      getCommitFiles: () =>
        Promise.resolve({
          items: [
            {
              path: 'a.ts',
              status: 'modified',
              additions: 10,
              deletions: 2,
              patchTruncated: false,
            },
            { path: 'b.ts', status: 'added', additions: 5, deletions: 0, patchTruncated: false },
          ],
          stats: { additions: 15, deletions: 2 },
        }),
    });
    const written = await enrichCommitChurn(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/r-enrich', sha: 'ec1' },
    );
    expect(written).toBe(2);

    const [commit] = await db
      .select()
      .from(facts.commits)
      .where(and(eq(facts.commits.repoId, repoId), eq(facts.commits.sha, 'ec1')));
    expect(commit).toMatchObject({
      additions: 15,
      deletions: 2,
      filesCount: 2,
      statsSource: 'detail',
    });
    const files = await db
      .select()
      .from(facts.commitFiles)
      .where(eq(facts.commitFiles.commitId, commit!.id));
    expect(files).toHaveLength(2);
  });
});
