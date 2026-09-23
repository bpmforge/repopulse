import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import webhookRoutes from './index.js';

// W17-36: the receiver was GitHub-shaped, and every forge registered its hook
// at /webhooks/github. This file pins what each forge actually sends.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// A real delivery, captured from a live Gitea 1.24.7 — see the fixture's _note.
const GITEA = JSON.parse(
  readFileSync(new URL('./fixtures/gitea-1.24.7-issues-opened.json', import.meta.url), 'utf8'),
) as { secret: string; headers: Record<string, string>; body: string };

const GITLAB_SECRET = 'w17-36-gitlab-token';
const GITHUB_SECRET = 'w17-36-github-secret';

describeIfLiveInfra('webhook receiver per forge (W17-36)', () => {
  const db: Database = createDb(databaseUrl as string);
  const tokenKey = randomBytes(32);
  const enqueueDelta = vi.fn(async (_spec: { data: { kind: string; repoId: number } }) => {});
  let app: FastifyInstance;
  let workspaceId: number;
  const repoIds: Record<string, number> = {};

  async function connectionWithRepo(
    userId: number,
    provider: 'github' | 'gitea' | 'gitlab',
    secret: string,
    org: string,
    name: string,
  ): Promise<void> {
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider,
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `w17-36-${provider}`,
        status: 'active',
        createdBy: userId,
        webhookSecretCiphertext: credentials.sealSecret(secret, tokenKey),
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: `w17-36-${provider}-${name}`,
        org,
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoIds[provider] = repo!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-36-hooks', name: 'w17-36-hooks' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w17-36-hooks' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w17-36-user',
        forgeUserId: 'w17-36-user',
        login: 'w17-36-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w17-36-user' } })
      .returning();
    // The SAME path on github.com and on the Gitea, GitHub inserted first: a
    // receiver that takes the first org/name match verifies a genuine Gitea
    // delivery against the GitHub connection's secret and rejects it.
    await connectionWithRepo(user!.id, 'github', GITHUB_SECRET, 'acme', 'widget');
    await connectionWithRepo(user!.id, 'gitea', GITEA.secret, 'acme', 'widget');
    // GitLab subgroups: the path has more than one slash.
    await connectionWithRepo(user!.id, 'gitlab', GITLAB_SECRET, 'platform/tools', 'widget');

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(webhookRoutes, { db, tokenKey, enqueueDelta });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w17-36-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  beforeEach(() => enqueueDelta.mockClear());

  it('accepts a captured Gitea 1.24.7 delivery at /webhooks/github, on the Gitea repo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: GITEA.headers,
      payload: GITEA.body,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueueDelta).toHaveBeenCalledTimes(1);
    expect(enqueueDelta.mock.calls[0]![0]).toMatchObject({
      data: { kind: 'issues', repoId: repoIds.gitea },
    });
  });

  it('rejects the same Gitea delivery when one body byte changes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { ...GITEA.headers, 'x-github-delivery': 'w17-36-tampered' },
      payload: GITEA.body.replace('"opened"', '"closed"'),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  const gitlabBody = JSON.stringify({
    object_kind: 'merge_request',
    project: { path_with_namespace: 'platform/tools/widget' },
    object_attributes: { action: 'open' },
  });

  it('GitLab: X-Gitlab-Token + "Merge Request Hook" at /webhooks/gitlab → 202, pull_requests delta', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': GITLAB_SECRET,
        'x-gitlab-event': 'Merge Request Hook',
        'idempotency-key': 'w17-36-gl-1',
      },
      payload: gitlabBody,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueueDelta.mock.calls[0]![0]).toMatchObject({
      data: { kind: 'pull_requests', repoId: repoIds.gitlab },
    });
  });

  it('GitLab: a wrong token → 401, nothing enqueued', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'not-the-token',
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-event-uuid': 'w17-36-gl-2',
      },
      payload: gitlabBody,
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it('GitLab: the GitHub connection secret cannot authenticate a GitLab-path delivery', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': GITHUB_SECRET,
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-event-uuid': 'w17-36-gl-3',
      },
      payload: JSON.stringify({ project: { path_with_namespace: 'acme/widget' } }),
    });
    expect(res.statusCode).toBe(401);
  });
});
