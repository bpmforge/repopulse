import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { auditLog, core, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  activateRepos,
  collectAllPages,
  createConnection,
  replaceConnectionCredential,
  ConnectValidationError,
} from '@repopulse/ingest';
import {
  ForgeHttpError,
  splitRepoFullName,
  type CallCtx,
  type ForgeCursor,
  type ForgeProvider,
  type ForgeRepo,
  type GitHubAuth,
} from '@repopulse/forge';
import { sendProblem } from '../../lib/problem.js';
import { requireAdmin } from '../../lib/rbac.js';
import {
  buildDiscoveryProvider,
  isMisresolvedGitlabRow,
  resolveConnectionBaseUrl,
  type ForgeKind,
} from './provider-factory.js';
import {
  availableReposResponseSchema,
  connectionIdParamsSchema,
  connectionListResponseSchema,
  createConnectionBodySchema,
  createConnectionResponseSchema,
  removeConnectionResponseSchema,
  replaceCredentialBodySchema,
  replaceCredentialResponseSchema,
  repoTrackingBodySchema,
  repoTrackingResponseSchema,
  selectReposBodySchema,
  selectReposResponseSchema,
} from './schema.js';

const WEBHOOK_EVENTS = ['pull_request', 'push', 'check_run', 'check_suite', 'issues', 'deployment'];
const CTX: CallCtx = { lane: 'user' };

/**
 * Where a forge's hook must point (W17-36), decided by its capability rather
 * than its name (FR-FORGE-7 capability gate). GitHub and Gitea share
 * /webhooks/github; GitLab's token scheme has its own route.
 */
export function webhookUrlFor(
  githubUrl: string,
  scheme: ForgeProvider['capabilities']['webhookScheme'],
): string {
  return scheme === 'gitlab-token'
    ? githubUrl.replace(/\/webhooks\/github$/, '/webhooks/gitlab')
    : githubUrl;
}

export interface EnqueueBackfillPlan {
  // The `plan {repoId}` job (INGESTION §6) — the planner reads the repo row for
  // its full name, so only workspaceId + repoId are needed here.
  (params: { workspaceId: number; repoId: number }): Promise<void>;
}

export interface ConnectionsRoutesOptions {
  db: Database;
  tokenKey: Buffer;
  webhookUrl: string;
  enqueueBackfillPlan: EnqueueBackfillPlan;
  /** App-mode app id (env); only needed for auth_kind='app'. */
  appId?: string | number;
  /** Injectable so tests supply a deterministic provider (default: real forge). */
  buildProvider?: (
    auth: GitHubAuth,
    kind?: 'github' | 'gitea' | 'gitlab',
    baseUrl?: string,
  ) => ForgeProvider;
  /** Forge API base URL — GitHub Enterprise Server, or a fake in e2e. */
  forgeBaseUrl?: string;
}

/** Every repository the token can see, across every page (W20-07, INS-52). */
function listAllRepos(forge: ForgeProvider): Promise<{ items: ForgeRepo[]; truncated: boolean }> {
  return collectAllPages<ForgeRepo, ForgeCursor>((cursor) => forge.listRepos(CTX, cursor));
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Same audit envelope every admin action writes (W12-09). */
function auditContext(request: FastifyRequest, workspaceId: number) {
  return { ip: request.ip, ua: request.headers['user-agent'] ?? null, workspaceId };
}

function ctxOf(request: FastifyRequest): { userId: number; workspaceId: number } | undefined {
  const userId = request.session.get('userId');
  const workspaceId = request.workspace?.id;
  if (userId === undefined || workspaceId === undefined) return undefined;
  return { userId, workspaceId };
}

// Explicit return-reply on early exits (same @fastify/session double-onSend
// guard as views/rbac — verified in W1-04/W5-01).
function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail ? { detail } : {});
  return reply;
}

export default async function connectionsRoutes(
  app: FastifyInstance,
  opts: ConnectionsRoutesOptions,
): Promise<void> {
  const { db, tokenKey } = opts;
  // baseUrl is now a PER-CONNECTION argument (W14-02); opts.forgeBaseUrl is
  // the fallback rather than the only answer.
  const buildProvider =
    opts.buildProvider ??
    ((auth: GitHubAuth, kind?: 'github' | 'gitea' | 'gitlab', baseUrl?: string) =>
      buildDiscoveryProvider(auth, baseUrl ?? opts.forgeBaseUrl, kind ?? 'github'));
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  function authFor(kind: 'pat' | 'app', credential: string, installationId?: string): GitHubAuth {
    if (kind === 'pat') return { kind: 'pat', token: credential };
    if (opts.appId === undefined || installationId === undefined) {
      throw new Error('app auth requires appId + installation_id');
    }
    return { kind: 'app', appId: opts.appId, privateKey: credential, installationId };
  }

  // Rebuilds a STORED connection's provider from the row's own forge kind and
  // base URL. Omitting them built a github.com provider for every connection:
  // a Gitea/GitLab/GHES row then 500'd on discovery and its self-hosted token
  // was sent to api.github.com. A null base_url (pre-W14-02 row) falls back to
  // the server default, same as POST /connections.
  async function providerForConnection(row: {
    provider: string;
    baseUrl: string | null;
    authKind: string;
    credentialCiphertext: Buffer;
    credentialIv: Buffer;
    keyVersion: number;
    appInstallationId: string | null;
  }): Promise<ForgeProvider> {
    const credential = credentials.decryptCredential(
      { ciphertext: row.credentialCiphertext, iv: row.credentialIv, keyVersion: row.keyVersion },
      tokenKey,
    );
    // W20-07 (UX_TODO INS-73): by kind, through the same resolver the worker
    // uses, and with a GitLab row the old worker fallback broke read as gitlab.com.
    const kind = row.provider as ForgeKind;
    const baseUrl = resolveConnectionBaseUrl(
      kind,
      isMisresolvedGitlabRow(row.provider, row.baseUrl) ? null : row.baseUrl,
      opts.forgeBaseUrl,
    );
    return buildProvider(
      authFor(row.authKind as 'pat' | 'app', credential, row.appInstallationId ?? undefined),
      kind,
      baseUrl,
    );
  }

  /** A removed connection holds no credential to call the forge with. */
  function removedConnection(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return fail(
      request,
      reply,
      409,
      'This connection was removed',
      'It holds no token any more. Replace its token in Settings → Connections to reconnect it.',
    );
  }

  /** The stored row, workspace-checked; 404 for another tenant's id (Law 5). */
  async function loadConnection(id: number, workspaceId: number) {
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(
        and(eq(core.forgeConnections.id, id), eq(core.forgeConnections.workspaceId, workspaceId)),
      )
      .limit(1);
    return row;
  }

  // POST /connections — smoke-test the credential, persist encrypted (👑).
  typedApp.post(
    '/connections',
    {
      preHandler: requireAdmin,
      schema: {
        body: createConnectionBodySchema,
        response: { 201: createConnectionResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const { provider, auth_kind, credential, installation_id, base_url } = request.body;

      // Gitea is self-hosted and has no host worth guessing. Refusing here, by
      // name, beats the alternative: a connection that stores fine and then
      // 404s on every call, which reads as a bad token.
      // W20-07 (UX_TODO INS-73): decided by forge kind in ONE place and stored
      // on the row, so the worker never fills a blank in differently.
      const baseUrl = resolveConnectionBaseUrl(provider, base_url, opts.forgeBaseUrl);
      if (provider === 'gitea' && !baseUrl) {
        return fail(
          request,
          reply,
          400,
          'base_url is required for Gitea',
          'Gitea is self-hosted, so there is no default instance to connect to. Give the connection its own base URL (or set FORGE_BASE_URL as the server-wide default).',
        );
      }

      let auth: GitHubAuth;
      try {
        auth = authFor(auth_kind, credential, installation_id);
      } catch (err) {
        return fail(request, reply, 400, 'Invalid credential', (err as Error).message);
      }
      const forge = buildProvider(auth, provider, baseUrl);

      try {
        const result = await createConnection(
          {
            db,
            encrypt: (pt) => credentials.encryptCredential(pt, tokenKey),
            smokeListRepos: () => forge.listRepos(CTX).then((p) => p.items),
            host: hostOf(baseUrl),
          },
          {
            workspaceId: ctx.workspaceId,
            provider,
            authKind: auth_kind,
            credential,
            createdBy: ctx.userId,
            ...(installation_id ? { appInstallationId: installation_id } : {}),
            // Resolved at creation, not read from the env later: an operator
            // who re-points FORGE_BASE_URL must not silently move connections
            // that were made against a different host.
            ...(baseUrl ? { baseUrl } : {}),
          },
        );
        return reply.code(201).send({
          id: result.connectionId,
          status: 'active',
          fingerprint: credentials.credentialFingerprint(credential),
        });
      } catch (err) {
        if (err instanceof ConnectValidationError) {
          // Distinct, actionable: bad_token / bad_scope / no_repos, and since
          // W20-07 (INS-64) wrong_url / tls_untrusted / cannot_reach.
          return fail(
            request,
            reply,
            400,
            `Credential validation failed: ${err.kind}`,
            err.message,
          );
        }
        throw err;
      }
    },
  );

  // GET /connections — list (fingerprint/last4/status only, never ciphertext) (👑).
  typedApp.get(
    '/connections',
    { preHandler: requireAdmin, schema: { response: { 200: connectionListResponseSchema } } },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const rows = await db
        .select({
          id: core.forgeConnections.id,
          provider: core.forgeConnections.provider,
          authKind: core.forgeConnections.authKind,
          fingerprint: core.forgeConnections.credentialFingerprint,
          status: core.forgeConnections.status,
          baseUrl: core.forgeConnections.baseUrl,
          repoCount: sql<number>`(select count(*)::int from ${core.repos} where ${core.repos.connectionId} = ${core.forgeConnections.id})`,
        })
        .from(core.forgeConnections)
        .where(eq(core.forgeConnections.workspaceId, ctx.workspaceId));
      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          auth_kind: r.authKind,
          fingerprint: r.fingerprint,
          // A removed connection's credential was wiped (W20-07, INS-08).
          last4: r.status === 'removed' ? '' : credentials.fingerprintLast4(r.fingerprint),
          status: r.status,
          repo_count: r.repoCount,
          base_url: r.baseUrl,
        })),
      });
    },
  );

  // GET /connections/{id}/available-repos — cached-at-connect discovery (👑).
  typedApp.get(
    '/connections/:id/available-repos',
    {
      preHandler: requireAdmin,
      schema: { params: connectionIdParamsSchema, response: { 200: availableReposResponseSchema } },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      if (row.status !== 'active') return removedConnection(request, reply);

      const forge = await providerForConnection(row);
      let repos: Awaited<ReturnType<typeof listAllRepos>>;
      try {
        repos = await listAllRepos(forge);
      } catch (err) {
        // W17-35: the adapters reject on an HTTP error rather than returning an
        // empty list, so say what the forge answered instead of a bare 500.
        if (err instanceof ForgeHttpError) {
          return fail(request, reply, 502, 'The forge refused the repository listing', err.message);
        }
        throw err;
      }

      // W20-07 (UX_TODO INS-10): which of these this connection already
      // tracks, and in what state. The picker listed everything the token
      // could see every time, so an admin could not tell what they had
      // already picked — and re-picking is what broke webhooks (INS-72).
      const trackedRows = await db
        .select({ forgeRepoId: core.repos.forgeRepoId, syncStatus: core.repos.syncStatus })
        .from(core.repos)
        .where(
          and(eq(core.repos.workspaceId, ctx.workspaceId), eq(core.repos.connectionId, row.id)),
        );
      const tracked = new Map(trackedRows.map((r) => [r.forgeRepoId, r.syncStatus]));

      return reply.send({
        items: repos.items.map((r) => {
          const { org, name } = splitRepoFullName(r.fullName, r.name);
          return {
            forge_repo_id: r.externalId,
            org,
            name,
            is_private: r.isPrivate,
            is_archived: r.isArchived,
            tracked: tracked.has(r.externalId),
            sync_status: tracked.get(r.externalId) ?? null,
          };
        }),
        total: repos.items.length,
        truncated: repos.truncated,
      });
    },
  );

  // POST /connections/{id}/repos — create pending_backfill rows + webhooks + plans (👑).
  typedApp.post(
    '/connections/:id/repos',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: selectReposBodySchema,
        response: { 200: selectReposResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      if (row.status !== 'active') return removedConnection(request, reply);

      const forge = await providerForConnection(row);
      let listed: Awaited<ReturnType<typeof listAllRepos>>;
      try {
        // Every page (W20-07, INS-52): a repo past the first page must be
        // trackable, or the picker offers what this call then ignores.
        listed = await listAllRepos(forge);
      } catch (err) {
        if (err instanceof ForgeHttpError) {
          return fail(request, reply, 502, 'The forge refused the repository listing', err.message);
        }
        throw err;
      }
      const candidates = listed.items.map((r) => {
        const { org, name } = splitRepoFullName(r.fullName, r.name);
        return {
          forgeRepoId: r.externalId,
          org,
          name,
          defaultBranch: r.defaultBranch,
          isPrivate: r.isPrivate,
          isArchived: r.isArchived,
          pushedAt: r.pushedAt,
        };
      });

      const repoIds = await activateRepos(
        {
          db,
          sealSecret: (pt) => credentials.sealSecret(pt, tokenKey),
          registerWebhook: (repoFullName, secret) =>
            forge.registerWebhook(
              CTX,
              repoFullName,
              webhookUrlFor(opts.webhookUrl, forge.capabilities.webhookScheme),
              secret,
              WEBHOOK_EVENTS,
            ),
          enqueuePlan: (repoId) =>
            opts.enqueueBackfillPlan({ workspaceId: ctx.workspaceId, repoId }),
          generateSecret: () => randomBytes(32).toString('hex'),
          // W20-07 (UX_TODO INS-72): reuse the connection's secret, so a second
          // batch does not orphan the hooks of the first.
          openSecret: (sealed) => credentials.openSecret(sealed, tokenKey),
        },
        {
          workspaceId: ctx.workspaceId,
          connectionId: request.params.id,
          candidates,
          selection: {
            ...(request.body.repo_forge_ids ? { forgeRepoIds: request.body.repo_forge_ids } : {}),
            ...(request.body.all_with_auto_add ? { allAutoAdd: true } : {}),
          },
        },
      );
      return reply.send({ repo_ids: repoIds });
    },
  );

  // PATCH /connections/{id} — replace the credential (👑) (W20-07, UX_TODO INS-08).
  //
  // The row stays, so every repo, cursor and webhook keeps pointing at it. Also
  // the way back for a REMOVED connection: a working token makes it active
  // again (its repos stay paused until someone resumes them).
  typedApp.patch(
    '/connections/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: replaceCredentialBodySchema,
        response: { 200: replaceCredentialResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      const { credential } = request.body;

      const kind = row.provider as ForgeKind;
      const baseUrl = resolveConnectionBaseUrl(kind, row.baseUrl, opts.forgeBaseUrl);
      let forge: ForgeProvider;
      try {
        forge = buildProvider(
          authFor(row.authKind as 'pat' | 'app', credential, row.appInstallationId ?? undefined),
          kind,
          baseUrl,
        );
      } catch (err) {
        return fail(request, reply, 400, 'Invalid credential', (err as Error).message);
      }
      try {
        const found = await replaceConnectionCredential(
          {
            db,
            encrypt: (pt) => credentials.encryptCredential(pt, tokenKey),
            smokeListRepos: () => forge.listRepos(CTX).then((p) => p.items),
            host: hostOf(baseUrl),
          },
          { workspaceId: ctx.workspaceId, connectionId: row.id, credential },
        );
        if (!found) return fail(request, reply, 404, 'Not Found');
      } catch (err) {
        if (err instanceof ConnectValidationError) {
          // The old credential is untouched: a bad replacement never
          // overwrites a working token.
          return fail(
            request,
            reply,
            400,
            `Credential validation failed: ${err.kind}`,
            err.message,
          );
        }
        throw err;
      }
      const fingerprint = credentials.credentialFingerprint(credential);
      auditLog(request.log, {
        event: 'connection.credential_replaced',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        // The fingerprint, never the credential (FR-AUTH-5).
        fingerprint,
      });
      return reply.send({ id: row.id, status: 'active', fingerprint });
    },
  );

  // DELETE /connections/{id} — remove a connection (👑) (W20-07, UX_TODO INS-08).
  //
  // What happens to the tracked repositories is the whole question, so the
  // answer is in the response and on the confirm step:
  //  - tracked nothing → the row is deleted outright;
  //  - tracked something → DISCONNECTED: the credential and the webhook secret
  //    are wiped, every repo is paused, and their history stays on every
  //    dashboard. Deleting the row would take `repos` and the whole warehouse
  //    with it (W16-59), which is a purge, not a disconnect, and is not offered.
  // Webhooks are not deregistered on the forge (no provider can delete a hook
  // yet); with the secret gone every delivery they send is refused with 401.
  typedApp.delete(
    '/connections/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        response: { 200: removeConnectionResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');

      const outcome = await db.transaction(async (tx) => {
        const paused = await tx
          .update(core.repos)
          .set({ syncStatus: 'paused' })
          .where(
            and(eq(core.repos.workspaceId, ctx.workspaceId), eq(core.repos.connectionId, row.id)),
          )
          .returning({ id: core.repos.id });
        const [anyRepo] = await tx
          .select({ id: core.repos.id })
          .from(core.repos)
          .where(eq(core.repos.connectionId, row.id))
          .limit(1);
        const scope = and(
          eq(core.forgeConnections.id, row.id),
          eq(core.forgeConnections.workspaceId, ctx.workspaceId),
        );
        if (!anyRepo) {
          await tx.delete(core.forgeConnections).where(scope);
          return { outcome: 'deleted' as const, paused: 0 };
        }
        await tx
          .update(core.forgeConnections)
          .set({
            status: 'removed',
            // Wiped, not kept "just in case": a removed connection must not
            // hold a working token.
            credentialCiphertext: Buffer.alloc(0),
            credentialIv: Buffer.alloc(0),
            credentialFingerprint: 'removed',
            webhookSecretCiphertext: null,
          })
          .where(scope);
        return { outcome: 'disconnected' as const, paused: paused.length };
      });

      auditLog(request.log, {
        event: 'connection.removed',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        outcome: outcome.outcome,
        pausedRepos: outcome.paused,
      });
      return reply.send({
        id: row.id,
        outcome: outcome.outcome,
        paused_repos: outcome.paused,
      });
    },
  );

  // PUT /repos/{id}/tracking — pause or resume one repo (👑) (W20-07, UX_TODO INS-09).
  //
  // Here rather than under routes/repos because resuming re-plans the backfill,
  // and this plugin owns that queue. Pausing stops every forge call for the
  // repo (the worker resolves no provider for it) and keeps its history.
  typedApp.put(
    '/repos/:id/tracking',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: repoTrackingBodySchema,
        response: { 200: repoTrackingResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const [repo] = await db
        .select({
          id: core.repos.id,
          syncStatus: core.repos.syncStatus,
          connectionStatus: core.forgeConnections.status,
        })
        .from(core.repos)
        .innerJoin(core.forgeConnections, eq(core.forgeConnections.id, core.repos.connectionId))
        .where(
          and(eq(core.repos.id, request.params.id), eq(core.repos.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      if (!repo) return fail(request, reply, 404, 'Not Found');

      if (request.body.paused) {
        await db
          .update(core.repos)
          .set({ syncStatus: 'paused' })
          .where(and(eq(core.repos.id, repo.id), eq(core.repos.workspaceId, ctx.workspaceId)));
        auditLog(request.log, {
          event: 'repo.tracking_paused',
          actorUserId: ctx.userId,
          ...auditContext(request, ctx.workspaceId),
          repoId: repo.id,
          fromStatus: repo.syncStatus,
        });
        return reply.send({ repo_id: repo.id, sync_status: 'paused' });
      }

      if (repo.syncStatus !== 'paused') {
        // Nothing to resume; say what it is rather than re-queue a live repo.
        return reply.send({ repo_id: repo.id, sync_status: repo.syncStatus });
      }
      if (repo.connectionStatus !== 'active') {
        return fail(
          request,
          reply,
          409,
          'Its connection was removed',
          'Replace the connection’s token in Settings → Connections first, then resume this repository.',
        );
      }
      // Re-planned from the cursors it stopped at: the plan job moves it on to
      // backfilling, and from there to live, exactly as a new repo goes.
      await db
        .update(core.repos)
        .set({ syncStatus: 'pending_backfill' })
        .where(and(eq(core.repos.id, repo.id), eq(core.repos.workspaceId, ctx.workspaceId)));
      await opts.enqueueBackfillPlan({ workspaceId: ctx.workspaceId, repoId: repo.id });
      auditLog(request.log, {
        event: 'repo.tracking_resumed',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        repoId: repo.id,
      });
      return reply.send({ repo_id: repo.id, sync_status: 'pending_backfill' });
    },
  );
}
