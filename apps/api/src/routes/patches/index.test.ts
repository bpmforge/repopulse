import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import patchRoutes, { PATCH_DRAFTS_PER_DAY } from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// Verified-patch routes (W18-19): auth and roles, Tier-3 opt-in, idempotency,
// the daily cap, and — the part that matters most to a developer — that a
// rejected patch discloses nothing to anyone but an admin.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const CSRF = { 'x-requested-with': 'repopulse' };
const WS_SLUG = 'w18-19-patches';
const USER_SUBJECT = 'w18-19-patches@example.com';
const SHA = 'b'.repeat(40);

describeIfLiveInfra('verified-patch routes (W18-19)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  const added: { name: string; data: unknown; jobId: string }[] = [];
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;
  let repoId = 0;
  let findingId = 0;
  let judgmentFindingId = 0;

  const fakeQueue = {
    add: vi.fn(async (name: string, data: unknown, opts: { jobId: string }) => {
      added.push({ name, data, jobId: opts.jobId });
      return { id: opts.jobId };
    }),
    close: async () => {},
  } as unknown as Queue;

  const as = (role: 'admin' | 'member') => ({ ...CSRF, 'x-test-role': role });

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: WS_SLUG, name: 'W18-19 patches' })
      .onConflictDoNothing()
      .returning({ id: core.workspaces.id });
    workspaceId =
      ws?.id ??
      (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, WS_SLUG))
      )[0]!.id;
    const [u] = await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: USER_SUBJECT,
        login: 'w18-19-patches',
        email: USER_SUBJECT,
      })
      .onConflictDoNothing()
      .returning({ id: core.users.id });
    userId =
      u?.id ??
      (
        await db
          .select({ id: core.users.id })
          .from(core.users)
          .where(eq(core.users.authSubject, USER_SUBJECT))
      )[0]!.id;
    const enc = credentials.encryptCredential('w18-19-fixture-token', Buffer.alloc(32, 3));
    const [c] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: userId,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = c!.id;
    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w18-19-patches-repo',
        org: 'w18-19',
        name: 'patches',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = r!.id;
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: SHA,
        trigger: 'schedule',
        status: 'succeeded',
      })
      .returning();
    const base = {
      workspaceId,
      repoId,
      scanRunId: run!.id,
      dimension: 'sast',
      severity: 4,
      confidence: 3,
      title: 'eval of input',
      file: 'src/run.js',
      lineStart: 2,
      lineEnd: 2,
      evidence: 'src/run.js:2 — bpm-eval',
      recommendation: 'Do not eval input.',
      tier: 1,
      status: 'open',
    };
    const [f] = await db
      .insert(read.findings)
      .values({ ...base, dedupKey: 'w18-19-key-1', scannerKey: 'semgrep', ruleId: 'bpm-eval' })
      .returning();
    findingId = f!.id;
    const [j] = await db
      .insert(read.findings)
      .values({
        ...base,
        dedupKey: 'w18-19-key-2',
        scannerKey: 'anti_slop',
        ruleId: 'slop.judgment',
      })
      .returning();
    judgmentFindingId = j!.id;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-no-session']) return;
      request.workspace = { id: workspaceId, slug: WS_SLUG, name: 'W18-19 patches' };
      request.role = request.headers['x-test-role'] === 'admin' ? 'admin' : 'member';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? userId : undefined),
      };
    });
    await app.register(patchRoutes, { db, queueFor: () => fakeQueue });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (repoId) {
      await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.repoId, repoId));
      await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
      await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
      await db.delete(core.repos).where(eq(core.repos.id, repoId));
    }
    if (connectionId)
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    if (userId) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, userId));
      await db.delete(core.users).where(eq(core.users.id, userId));
    }
    if (workspaceId) await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  beforeEach(async () => {
    added.length = 0;
    vi.clearAllMocks();
    await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.repoId, repoId));
    await db.update(core.repos).set({ tier3OptIn: false }).where(eq(core.repos.id, repoId));
  });

  async function setRow(values: Partial<typeof read.verifiedPatches.$inferInsert>) {
    const [row] = await db
      .insert(read.verifiedPatches)
      .values({
        workspaceId,
        repoId,
        findingId,
        commitSha: SHA,
        targetDedupKey: 'w18-19-key-1',
        ...values,
      })
      .returning();
    return row!;
  }

  it('401s without a session, on both verbs', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: `/findings/${findingId}/patch`,
        headers: { ...CSRF, 'x-no-session': '1' },
      });
      expect(res.statusCode, method).toBe(401);
    }
  });

  it('404s a finding that is not in this workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/findings/999999999/patch',
      headers: as('member'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('a model finding is not eligible: there is no rule to re-run', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `/findings/${judgmentFindingId}/patch`,
      headers: as('member'),
    });
    expect(get.json()).toMatchObject({ eligible: false, patch: null });
    const post = await app.inject({
      method: 'POST',
      url: `/findings/${judgmentFindingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(post.statusCode).toBe(409);
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('a member may request a local (Tier-2) draft, once per finding and snapshot', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().patch).toMatchObject({ status: 'pending', tier: 2, commit_sha: SHA });
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({ workspaceId, patchId: first.json().patch.id });

    const second = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().patch.id).toBe(first.json().patch.id);
    expect(added).toHaveLength(1);
  });

  it('Tier-3 needs an admin AND the repository opt-in', async () => {
    const member = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: { tier: 't3' },
    });
    expect(member.statusCode).toBe(403);
    const notOptedIn = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('admin'),
      payload: { tier: 't3' },
    });
    expect(notOptedIn.statusCode).toBe(409);
    expect(added).toHaveLength(0);

    await db.update(core.repos).set({ tier3OptIn: true }).where(eq(core.repos.id, repoId));
    const ok = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('admin'),
      payload: { tier: 't3' },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().patch.tier).toBe(3);

    const bad = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('admin'),
      payload: { tier: 'cloud' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('a verified patch is served with its diff and a download name', async () => {
    await setRow({
      status: 'verified',
      reasonCode: 'verified',
      reason: 'clears',
      diff: '--- a/src/run.js\n+++ b/src/run.js\n',
      modelId: 'local-model',
      verificationRuns: [
        { runner: 'semgrep_pack', state: 'before' },
        { runner: 'semgrep_pack', state: 'after' },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
    });
    expect(res.statusCode).toBe(200);
    const patch = res.json().patch;
    expect(patch).toMatchObject({ status: 'verified', model_id: 'local-model' });
    expect(patch.diff).toContain('+++ b/src/run.js');
    expect(patch.filename).toBe(`repopulse-finding-${findingId}-run.js.patch`);
    expect(patch.verification).toEqual({ rule_sets: ['semgrep_pack'], runs: 2 });
    // The reason is an admin's; a member does not get it even for a good patch.
    expect(patch).not.toHaveProperty('reason');
  });

  it('a REJECTED patch discloses nothing to a member, and its reason to an admin', async () => {
    await setRow({
      status: 'rejected',
      reasonCode: 'new_finding',
      reason: 'The patch introduces a new finding in the file: bpm-inner-html.',
      diff: '--- a/src/run.js\n+++ b/src/run.js\n@@ -1 +1 @@\n-x\n+el.innerHTML = x',
      modelId: 'local-model',
    });
    const member = (
      await app.inject({
        method: 'GET',
        url: `/findings/${findingId}/patch`,
        headers: as('member'),
      })
    ).json();
    expect(member.patch.status).toBe('rejected');
    expect(JSON.stringify(member)).not.toContain('innerHTML');
    expect(member.patch).not.toHaveProperty('diff');
    expect(member.patch).not.toHaveProperty('reason');

    const admin = (
      await app.inject({ method: 'GET', url: `/findings/${findingId}/patch`, headers: as('admin') })
    ).json();
    expect(admin.patch).toMatchObject({ status: 'rejected', reason_code: 'new_finding' });
    expect(admin.patch.reason).toContain('bpm-inner-html');

    // And asking again returns the verdict rather than spending another call.
    const again = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(added).toHaveLength(0);
  });

  it('W20-06 (UX_TODO AI-13): a REJECTED draft is re-asked only on an explicit retry', async () => {
    const rejected = await setRow({
      status: 'rejected',
      reasonCode: 'new_finding',
      reason: 'introduces a finding',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: { tier: 't2', retry: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().patch).toMatchObject({ id: rejected.id, status: 'pending' });
    expect(added).toHaveLength(1);
  });

  it('W20-06 (UX_TODO AI-12): says which connection drafts the fix and whether the file leaves, before asking', async () => {
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId,
        name: 'Gemini',
        kind: 'gemini',
        baseUrl: null,
        model: 'gemini-2.5-flash',
        allowPublicHost: true,
        enabled: true,
      })
      .returning({ id: core.llmProviders.id });
    try {
      await db
        .insert(core.llmRoleRoutes)
        .values({ workspaceId, role: 'patch', position: 0, providerId: p!.id });
      const body = (
        await app.inject({
          method: 'GET',
          url: `/findings/${findingId}/patch`,
          headers: as('member'),
        })
      ).json();
      expect(body.drafter.leaves_network).toBe(true);
      expect(body.drafter.destinations).toEqual([
        {
          provider_name: 'Gemini',
          host: 'generativelanguage.googleapis.com',
          leaves_network: true,
          models: ['gemini-2.5-flash'],
        },
      ]);
      // Never a credential or a path.
      expect(JSON.stringify(body.drafter)).not.toMatch(/key|v1beta/);
    } finally {
      await db.delete(core.llmProviders).where(eq(core.llmProviders.id, p!.id));
    }
  });

  it('a FAILED attempt may be retried, and is re-enqueued under a fresh job id', async () => {
    const failed = await setRow({ status: 'failed', reasonCode: 'no_gateway', reason: 'No model' });
    const res = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().patch).toMatchObject({ id: failed.id, status: 'pending' });
    expect(added).toHaveLength(1);
  });

  it('refuses past the workspace daily cap', async () => {
    await db.insert(read.verifiedPatches).values(
      Array.from({ length: PATCH_DRAFTS_PER_DAY }, (_, i) => ({
        workspaceId,
        repoId,
        findingId: judgmentFindingId,
        commitSha: `cap-${i}`,
        targetDedupKey: 'k',
        status: 'rejected',
      })),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/findings/${findingId}/patch`,
      headers: as('member'),
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    expect(added).toHaveLength(0);
  });

  it('the attempts list with reasons is admin-only', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/admin/patches', headers: as('member') }))
        .statusCode,
    ).toBe(403);
    await setRow({ status: 'rejected', reasonCode: 'target_moved', reason: 'moved' });
    const admin = await app.inject({ method: 'GET', url: '/admin/patches', headers: as('admin') });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().items[0]).toMatchObject({
      finding_id: findingId,
      reason_code: 'target_moved',
    });
  });

  it('names what each attempt was for and splits every attempt by outcome (W18-29)', async () => {
    await setRow({ status: 'rejected', reasonCode: 'target_moved', reason: 'moved' });
    const res = await app.inject({ method: 'GET', url: '/admin/patches', headers: as('admin') });
    const body = res.json() as {
      counts: Record<string, number>;
      items: { finding: { title: string | null; file: string | null }; repo: { id: number } }[];
    };
    expect(body.counts.rejected).toBeGreaterThanOrEqual(1);
    expect(body.items[0]!.finding.title).toEqual(expect.any(String));
    expect(body.items[0]!.finding.file).toEqual(expect.any(String));
    expect(body.items[0]!.repo.id).toEqual(expect.any(Number));
  });
  // W20-11 (UX_TODO AI-65): a member sees why a draft could not be made when
  // the reason is not sensitive, and nothing more.
  it('gives a member the reason code of a non-sensitive failure, never the text', async () => {
    await setRow({ status: 'failed', reasonCode: 'model_busy', reason: 'ECONNRESET 10.0.0.5' });
    const member = (
      await app.inject({
        method: 'GET',
        url: `/findings/${findingId}/patch`,
        headers: as('member'),
      })
    ).json();
    expect(member.patch).toMatchObject({ status: 'failed', reason_code: 'model_busy' });
    expect(JSON.stringify(member)).not.toContain('ECONNRESET');
  });

  it('keeps any other failure code from a member', async () => {
    await setRow({ status: 'failed', reasonCode: 'error', reason: 'stack trace' });
    const member = (
      await app.inject({
        method: 'GET',
        url: `/findings/${findingId}/patch`,
        headers: as('member'),
      })
    ).json();
    expect(member.patch.reason_code ?? null).toBeNull();
  });

  // W20-11 (UX_TODO AI-66): filter by outcome, model and repository; page by cursor.
  it('filters the attempts list and pages back by cursor', async () => {
    const a = await setRow({ status: 'rejected', modelId: 'm1', commitSha: 'a'.repeat(40) });
    const b = await setRow({ status: 'verified', modelId: 'm2', commitSha: 'b'.repeat(40) });
    const get = async (qs: string) =>
      app.inject({ method: 'GET', url: `/admin/patches${qs}`, headers: as('admin') });
    const rejected = (await get('?status=rejected')).json();
    expect(rejected.items.map((i: { id: number }) => i.id)).toEqual([a.id]);
    expect(rejected.models).toEqual(['m1', 'm2']);
    expect(rejected.repos).toEqual([expect.objectContaining({ id: repoId })]);
    const byModel = (await get('?model=m2')).json();
    expect(byModel.items.map((i: { id: number }) => i.id)).toEqual([b.id]);
    expect((await get(`?repo_id=${repoId}`)).json().items).toHaveLength(2);
    expect((await get(`?repo_id=${repoId + 100000}`)).json().items).toHaveLength(0);
    const older = (await get(`?before=${b.id}`)).json();
    expect(older.items.map((i: { id: number }) => i.id)).toEqual([a.id]);
    expect(older.next_cursor).toBeNull();
    expect((await get('?status=nope')).statusCode).toBe(400);
    expect((await get('?before=x')).statusCode).toBe(400);
    expect((await get('?repo_id=x')).statusCode).toBe(400);
  });
});
