import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import {
  GitHubProvider,
  GiteaProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgeResponse,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEntityPages } from './backfill.js';
import { repoSyncStatus } from '../status/status.js';

// W17-39 (residual R-16): an entity whose FEATURE is switched off on the repo
// is "not enabled on this repo" — informational, empty, finished — and not the
// W17-35 error. The answers below are the ones observed live on 2026-09-23
// (see packages/forge/test/repo-features.contract.test.ts):
//   Gitea 1.24.7 disabled issues/pulls -> 404; GitHub has_issues=false -> 200,
//   empty or pull requests only.
// The repo metadata decides; a refusal on a repo whose feature is ON (or whose
// metadata cannot be read) is still the W17-35 error.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

type Canned = Record<string, { status: number; body: unknown; headers?: Record<string, string> }>;

function clientOver(canned: Canned): ForgeHttpClient {
  return {
    request: (_ctx, req): Promise<ForgeResponse> => {
      const r = canned[req.url];
      if (!r) throw new Error(`canned client: no response for ${req.method} ${req.url}`);
      return Promise.resolve({
        status: r.status,
        headers: r.headers ?? {},
        body: r.body,
        servedFromCache: false,
      });
    },
  };
}
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'w17-39-test' });

const GT = 'https://git.example.com/api/v1/repos';
const gitea = (canned: Canned) =>
  new GiteaProvider({ client: clientOver(canned), auth, baseUrl: 'https://git.example.com' });
const github = (canned: Canned) => new GitHubProvider({ client: clientOver(canned), auth });

const GITEA_404 = { status: 404, body: { message: "The target couldn't be found." } };
const giteaRepo = (name: string, flags: Record<string, boolean>) => ({
  status: 200,
  body: {
    id: 1,
    name,
    full_name: `acme/${name}`,
    default_branch: 'main',
    private: true,
    archived: false,
    html_url: `https://git.example.com/acme/${name}`,
    ...flags,
  },
});
const githubRepo = (name: string, hasIssues: boolean) => ({
  status: 200,
  body: {
    id: 2,
    name,
    full_name: `acme/${name}`,
    default_branch: 'main',
    private: false,
    archived: false,
    pushed_at: null,
    html_url: `https://github.com/acme/${name}`,
    has_issues: hasIssues,
  },
});
const GT_ISSUES = (name: string) =>
  `${GT}/acme/${name}/issues?state=all&type=issues&page=1&limit=50`;
const GT_PULLS = (name: string) =>
  `${GT}/acme/${name}/pulls?state=all&sort=recentupdate&page=1&limit=50`;
const GH_ISSUES = (name: string) =>
  `https://api.github.com/repos/acme/${name}/issues?state=all&per_page=100`;

describeIfLiveInfra(
  'a disabled forge feature reads as "not enabled", not as an error (W17-39)',
  () => {
    const db: Database = createDb(databaseUrl as string);
    let workspaceId: number;
    let connectionId: number;

    async function makeRepo(name: string, lastError: string | null = null): Promise<number> {
      const [repo] = await db
        .insert(core.repos)
        .values({
          workspaceId,
          connectionId,
          forgeRepoId: `w17-39-${name}`,
          org: 'acme',
          name,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'backfilling',
          tier2Auto: false,
          lastError,
        })
        .returning();
      return repo!.id;
    }

    async function repoLastError(repoId: number): Promise<string | null> {
      const [r] = await db
        .select({ lastError: core.repos.lastError })
        .from(core.repos)
        .where(eq(core.repos.id, repoId));
      return r?.lastError ?? null;
    }

    async function cursor(repoId: number, entity: string) {
      const [row] = await db
        .select({
          done: core.syncCursors.backfillDone,
          lastError: core.syncCursors.lastError,
          featureDisabled: core.syncCursors.featureDisabled,
        })
        .from(core.syncCursors)
        .where(and(eq(core.syncCursors.repoId, repoId), eq(core.syncCursors.entityType, entity)));
      return row;
    }

    beforeAll(async () => {
      const [ws] = await db
        .insert(core.workspaces)
        .values({ slug: 'w17-39-feature-off', name: 'w17-39-feature-off' })
        .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w17-39-feature-off' } })
        .returning();
      workspaceId = ws!.id;
      const [user] = await db
        .insert(core.users)
        .values({
          authProvider: 'github',
          authSubject: 'w17-39-user',
          forgeUserId: 'w17-39-user',
          login: 'w17-39-user',
        })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w17-39-user' } })
        .returning();
      const [conn] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId,
          provider: 'gitea',
          baseUrl: 'https://git.example.com',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('x'),
          credentialIv: Buffer.from('iv-1234567890123'),
          keyVersion: 1,
          credentialFingerprint: 'w17-39-fp',
          status: 'active',
          createdBy: user!.id,
        })
        .returning();
      connectionId = conn!.id;
    });

    afterAll(async () => {
      await db.delete(facts.issues).where(eq(facts.issues.workspaceId, workspaceId));
      await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
      await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
      await db
        .delete(core.forgeConnections)
        .where(eq(core.forgeConnections.workspaceId, workspaceId));
      await db.delete(core.users).where(eq(core.users.forgeUserId, 'w17-39-user'));
      await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
      await db.$client.end();
    });

    it('Gitea: 404 on issues with has_issues=false is "not enabled", with no error anywhere', async () => {
      const repoId = await makeRepo('noissues');
      const provider = gitea({
        [GT_ISSUES('noissues')]: GITEA_404,
        [`${GT}/acme/noissues`]: giteaRepo('noissues', { has_issues: false }),
      });
      const result = await ingestEntityPages(
        { db, provider, provider_kind: 'gitea' },
        { workspaceId, repoId, repo: 'acme/noissues', entityType: 'issues' },
      );
      expect(result).toMatchObject({ done: true, notEnabled: true });
      expect(result.failed).toBeUndefined();
      expect(await repoLastError(repoId)).toBeNull();
      expect(await cursor(repoId, 'issues')).toEqual({
        done: true,
        lastError: null,
        featureDisabled: true,
      });
      const status = await repoSyncStatus(db, repoId);
      expect(status?.entities.issues).toMatchObject({ done: true, error: null, notEnabled: true });
    });

    it('Gitea: 404 on pulls with has_pull_requests=false is "not enabled" too', async () => {
      const repoId = await makeRepo('nopulls');
      const provider = gitea({
        [GT_PULLS('nopulls')]: GITEA_404,
        [`${GT}/acme/nopulls`]: giteaRepo('nopulls', {
          has_issues: true,
          has_pull_requests: false,
        }),
      });
      const result = await ingestEntityPages(
        { db, provider, provider_kind: 'gitea' },
        { workspaceId, repoId, repo: 'acme/nopulls', entityType: 'prs' },
      );
      expect(result).toMatchObject({ done: true, notEnabled: true });
      expect(await repoLastError(repoId)).toBeNull();
    });

    it('clears the error a pre-fix run recorded for the same disabled feature', async () => {
      const earlier = 'issues not ingested — HTTP 404: The target couldn’t be found.';
      const webhook = 'live updates unavailable — webhook registration failed: 403';
      const repoId = await makeRepo('wasred', `${webhook} · ${earlier}`);
      await db.insert(core.syncCursors).values({
        workspaceId,
        repoId,
        entityType: 'issues',
        backfillDone: true,
        lastError: earlier,
      });
      await ingestEntityPages(
        {
          db,
          provider: gitea({
            [GT_ISSUES('wasred')]: GITEA_404,
            [`${GT}/acme/wasred`]: giteaRepo('wasred', { has_issues: false }),
          }),
          provider_kind: 'gitea',
        },
        { workspaceId, repoId, repo: 'acme/wasred', entityType: 'issues' },
      );
      expect(await repoLastError(repoId)).toBe(webhook);
      expect((await cursor(repoId, 'issues'))?.lastError).toBeNull();
    });

    it('Gitea: 404 on issues with has_issues=true is still the W17-35 error', async () => {
      const repoId = await makeRepo('enabled404');
      const result = await ingestEntityPages(
        {
          db,
          provider: gitea({
            [GT_ISSUES('enabled404')]: GITEA_404,
            [`${GT}/acme/enabled404`]: giteaRepo('enabled404', { has_issues: true }),
          }),
          provider_kind: 'gitea',
        },
        { workspaceId, repoId, repo: 'acme/enabled404', entityType: 'issues' },
      );
      expect(result.failed).toMatchObject({ status: 404 });
      expect(result.notEnabled).toBeUndefined();
      expect(await repoLastError(repoId)).toMatch(/issues not ingested — HTTP 404/);
    });

    it('metadata that cannot be read is "unknown" and keeps the error', async () => {
      const repoId = await makeRepo('unknown');
      const result = await ingestEntityPages(
        {
          db,
          provider: gitea({
            [GT_ISSUES('unknown')]: GITEA_404,
            [`${GT}/acme/unknown`]: GITEA_404,
          }),
          provider_kind: 'gitea',
        },
        { workspaceId, repoId, repo: 'acme/unknown', entityType: 'issues' },
      );
      expect(result.failed).toMatchObject({ status: 404 });
      expect((await cursor(repoId, 'issues'))?.featureDisabled).toBe(false);
    });

    it('GitHub: 200 [] with has_issues=false is "not enabled"', async () => {
      const repoId = await makeRepo('gh-empty');
      const result = await ingestEntityPages(
        {
          db,
          provider: github({
            [GH_ISSUES('gh-empty')]: { status: 200, body: [] },
            ['https://api.github.com/repos/acme/gh-empty']: githubRepo('gh-empty', false),
          }),
        },
        { workspaceId, repoId, repo: 'acme/gh-empty', entityType: 'issues' },
      );
      expect(result).toMatchObject({ done: true, notEnabled: true });
      expect((await cursor(repoId, 'issues'))?.featureDisabled).toBe(true);
    });

    it('GitHub: pull requests only (git/git shape) with has_issues=false is "not enabled", nothing written', async () => {
      const repoId = await makeRepo('gh-prs-only');
      const prAsIssue = {
        id: 77,
        number: 12,
        title: 'a PR',
        user: { login: 'dev', id: 5, type: 'User' },
        state: 'open',
        created_at: '2026-09-01T00:00:00Z',
        closed_at: null,
        pull_request: { url: 'https://api.github.com/repos/acme/gh-prs-only/pulls/12' },
      };
      const result = await ingestEntityPages(
        {
          db,
          provider: github({
            [GH_ISSUES('gh-prs-only')]: {
              status: 200,
              body: [prAsIssue],
              headers: {
                link: '<https://api.github.com/repos/acme/gh-prs-only/issues?state=all&per_page=100&page=2>; rel="next"',
              },
            },
            ['https://api.github.com/repos/acme/gh-prs-only']: githubRepo('gh-prs-only', false),
          }),
        },
        { workspaceId, repoId, repo: 'acme/gh-prs-only', entityType: 'issues' },
      );
      // Finished on the first page: walking every PR through /issues would spend
      // budget on rows the prs entity already ingests.
      expect(result).toMatchObject({ done: true, notEnabled: true });
      const rows = await db.select().from(facts.issues).where(eq(facts.issues.repoId, repoId));
      expect(rows).toHaveLength(0);
    });

    it('GitHub: 200 [] with has_issues=true is simply a repo with no issues', async () => {
      const repoId = await makeRepo('gh-none');
      const result = await ingestEntityPages(
        {
          db,
          provider: github({
            [GH_ISSUES('gh-none')]: { status: 200, body: [] },
            ['https://api.github.com/repos/acme/gh-none']: githubRepo('gh-none', true),
          }),
        },
        { workspaceId, repoId, repo: 'acme/gh-none', entityType: 'issues' },
      );
      expect(result).toMatchObject({ done: true });
      expect(result.notEnabled).toBeUndefined();
      expect((await cursor(repoId, 'issues'))?.featureDisabled).toBe(false);
    });
  },
);
