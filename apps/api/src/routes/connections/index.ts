import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
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
  isScheduledOnly,
  readWorkspaceSettings,
  setConnectionAutoAdd,
  setConnectionScheduledOnly,
  skipAutoAdd,
} from '../../lib/workspace-settings.js';
import { egressRecordCount, purgeRepoHistory } from '../../lib/purge-repo.js';
import {
  autoAddBodySchema,
  autoAddResponseSchema,
  availableReposResponseSchema,
  connectionIdParamsSchema,
  connectionListResponseSchema,
  createConnectionBodySchema,
  createConnectionResponseSchema,
  purgeRepoBodySchema,
  purgeRepoResponseSchema,
  removeConnectionResponseSchema,
  replaceCredentialBodySchema,
  replaceCredentialResponseSchema,
  repoTrackingBodySchema,
  repoTrackingResponseSchema,
  scheduledSyncBodySchema,
  scheduledSyncResponseSchema,
  selectReposBodySchema,
  selectReposResponseSchema,
  syncNowResponseSchema,
} from './schema.js';

export const WEBHOOK_EVENTS = [
  'pull_request',
  'push',
  'check_run',
  'check_suite',
  'issues',
  'deployment',
];
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
  /**
   * Queue one reconcile pass for a live repository now (W20-22, INS-30): the
   * same budgeted job the nightly sweep runs. Absent, "Sync now" answers 503.
   */
  enqueueReconcile?: (params: { workspaceId: number; repoId: number }) => Promise<void>;
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

  type HookRepo = { id: number; org: string; name: string };
  type HookFailure = { repo: string; error: string };

  /**
   * Delete the push hooks this install registered on each repository, matched
   * by delivery URL (W20-17), one at a time through the budgeted provider
   * (Law 7). Never throws: a failure is reported per repository.
   */
  async function removeHooks(
    row: Parameters<typeof providerForConnection>[0],
    repos: HookRepo[],
  ): Promise<{ removed: number; failures: HookFailure[] }> {
    const failures: HookFailure[] = [];
    let removed = 0;
    if (repos.length === 0) return { removed, failures };
    let forge: ForgeProvider;
    try {
      forge = await providerForConnection(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        removed,
        failures: repos.map((r) => ({ repo: `${r.org}/${r.name}`, error: message.slice(0, 300) })),
      };
    }
    const url = webhookUrlFor(opts.webhookUrl, forge.capabilities.webhookScheme);
    for (const repo of repos) {
      const fullName = `${repo.org}/${repo.name}`;
      if (!forge.deleteWebhooks) {
        failures.push({ repo: fullName, error: 'this forge cannot remove hooks here' });
        continue;
      }
      try {
        removed += await forge.deleteWebhooks(
          { lane: 'user', repoId: String(repo.id) },
          fullName,
          url,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ repo: fullName, error: message.slice(0, 300) });
      }
    }
    return { removed, failures };
  }

  /** The connection's webhook secret, or null when it has none it can open. */
  function openWebhookSecret(row: { webhookSecretCiphertext: Buffer | null }): string | null {
    if (!row.webhookSecretCiphertext) return null;
    try {
      return credentials.openSecret(row.webhookSecretCiphertext, tokenKey);
    } catch {
      return null;
    }
  }

  /**
   * Register a push hook at today's address on each repository, signed with
   * the connection's secret (W20-10), one at a time through the budgeted
   * provider (a burst of hook creations is what a secondary rate limit
   * punishes). Clears a repository's earlier "live updates unavailable" note
   * when its hook goes in. Never throws for a single repository.
   */
  async function registerHooks(
    row: Parameters<typeof providerForConnection>[0],
    repos: HookRepo[],
    secret: string,
    workspaceId: number,
  ): Promise<{
    url: string;
    registered: number;
    failed: { repo_id: number; repo: string; error: string }[];
  }> {
    const forge = await providerForConnection(row);
    const url = webhookUrlFor(opts.webhookUrl, forge.capabilities.webhookScheme);
    const failed: { repo_id: number; repo: string; error: string }[] = [];
    let registered = 0;
    for (const repo of repos) {
      const fullName = `${repo.org}/${repo.name}`;
      try {
        await forge.registerWebhook(CTX, fullName, url, secret, WEBHOOK_EVENTS);
        registered += 1;
        // Clears only the note an earlier failed registration left.
        await db
          .update(core.repos)
          .set({ lastError: null })
          .where(
            and(
              eq(core.repos.id, repo.id),
              eq(core.repos.workspaceId, workspaceId),
              sql`${core.repos.lastError} like 'live updates unavailable%'`,
            ),
          );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ repo_id: repo.id, repo: fullName, error: message.slice(0, 300) });
      }
    }
    return { url, registered, failed };
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
      const { provider, auth_kind, credential, installation_id, base_url, scheduled_sync_only } =
        request.body;

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
          // INS-25: in the form's words, not the API field name.
          'Enter your Gitea address',
          'Gitea is self-hosted, so there is no default instance to connect to. Enter its address in Instance URL, e.g. https://git.example.com (or set FORGE_BASE_URL as the server-wide default).',
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
        // W20-19 (UX_TODO INS-69): chosen on the connect form, before any
        // repository is tracked, so no hook is ever registered for it.
        if (scheduled_sync_only) {
          await setConnectionScheduledOnly(db, ctx.workspaceId, result.connectionId, true);
        }
        return reply.code(201).send({
          id: result.connectionId,
          status: 'active',
          fingerprint: credentials.credentialFingerprint(credential),
          scheduled_sync_only: scheduled_sync_only === true,
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
          createdAt: core.forgeConnections.createdAt,
          createdBy: core.users.login,
        })
        .from(core.forgeConnections)
        .leftJoin(core.users, eq(core.users.id, core.forgeConnections.createdBy))
        .where(eq(core.forgeConnections.workspaceId, ctx.workspaceId));
      const { stored } = await readWorkspaceSettings(db, ctx.workspaceId);
      const autoAdd = new Set(stored.auto_add_connection_ids ?? []);
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
          auto_add: r.status === 'active' && autoAdd.has(r.id),
          scheduled_sync_only: isScheduledOnly(stored, r.id),
          created_at: r.createdAt.toISOString(),
          created_by: r.createdBy ?? null,
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
      // W20-19 (UX_TODO INS-69): no hook for a "scheduled sync only" connection.
      const scheduledOnly = isScheduledOnly(
        (await readWorkspaceSettings(db, ctx.workspaceId)).stored,
        row.id,
      );
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
            scheduledOnly
              ? Promise.resolve('')
              : forge.registerWebhook(
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
      // W20-17 (UX_TODO INS-09): "Track all and auto-add new" also tracks
      // repositories created later; the nightly reconcile sweep adds them.
      if (request.body.all_with_auto_add) {
        await setConnectionAutoAdd(db, ctx.workspaceId, request.params.id, true);
      }
      // INS-29: name the repos whose webhook the forge refused. activateRepos
      // records that on the row rather than failing the batch, so the screen
      // used to report success with no hint that live updates were missing.
      const refused =
        repoIds.length === 0
          ? []
          : await db
              .select({ org: core.repos.org, name: core.repos.name })
              .from(core.repos)
              .where(
                and(
                  eq(core.repos.workspaceId, ctx.workspaceId),
                  inArray(core.repos.id, repoIds),
                  like(core.repos.lastError, 'live updates unavailable%'),
                ),
              );
      return reply.send({
        repo_ids: repoIds,
        webhook_failed: refused.map((r) => `${r.org}/${r.name}`),
      });
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

  // POST /connections/{id}/webhooks — re-register every tracked repository's
  // push webhook at the CURRENT address (👑) (W20-10, UX_TODO ADM-77).
  //
  // A hook is registered once, when its repository is first tracked, pointing
  // at PUBLIC_BASE_URL as it was then. After moving the install (a new server,
  // a new domain, http → https) every forge kept delivering to the old address
  // and live updates stopped with no warning; only the nightly reconcile still
  // ran. This registers a hook at today's URL, signed with the connection's
  // existing secret, for each repository that is not paused. Hooks at the OLD
  // address are not deleted (no provider can delete a hook yet); they fail
  // against a host that no longer answers, and the RUNBOOK says to remove them
  // in the forge. A forge that already has a hook at this exact URL refuses a
  // duplicate, which is reported per repository and is harmless.
  typedApp.post<{ Params: { id: string } }>(
    '/connections/:id/webhooks',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid connection id');
      const row = await loadConnection(id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      if (row.status !== 'active') return removedConnection(request, reply);
      if (isScheduledOnly((await readWorkspaceSettings(db, ctx.workspaceId)).stored, row.id)) {
        return fail(
          request,
          reply,
          409,
          'This connection is set to scheduled sync only',
          'It registers no webhooks. Turn "Scheduled sync only" off in Settings → Connections to register them.',
        );
      }

      const secret = openWebhookSecret(row);
      if (secret === null) {
        return fail(
          request,
          reply,
          409,
          'This connection has no webhook secret to sign with',
          'Track a repository on it first (that creates the secret), or replace its token if TOKEN_ENC_KEY changed.',
        );
      }

      const repos = await db
        .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, ctx.workspaceId),
            eq(core.repos.connectionId, row.id),
            sql`${core.repos.syncStatus} <> 'paused'`,
          ),
        );

      const { url, registered, failed } = await registerHooks(row, repos, secret, ctx.workspaceId);

      auditLog(request.log, {
        event: 'connection.webhooks_reregistered',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        url,
        registered,
        failed: failed.length,
      });
      return reply.send({ url, repos: repos.length, registered, failed });
    },
  );

  // PUT /connections/{id}/scheduled-sync — "scheduled sync only" on or off (👑)
  // (W20-19, UX_TODO INS-69; decision 2026-10-20).
  //
  // A private install the forge cannot reach still registered a push hook on
  // every repository, pointing at an internal PUBLIC_BASE_URL; each one then
  // collected failed deliveries the org's forge admins could see. On: the
  // hooks this install registered are deleted (deleteWebhooks, the D9a
  // allowed write) and none are registered from then on. Off: a hook is
  // registered again on each repository that is not paused. The nightly
  // reconcile sweep syncs these repositories either way.
  typedApp.put(
    '/connections/:id/scheduled-sync',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: scheduledSyncBodySchema,
        response: { 200: scheduledSyncResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      if (row.status !== 'active') return removedConnection(request, reply);
      const { enabled } = request.body;
      const was = isScheduledOnly(
        (await readWorkspaceSettings(db, ctx.workspaceId)).stored,
        row.id,
      );

      let webhooksRemoved = 0;
      let webhooksRegistered = 0;
      const failures: HookFailure[] = [];
      if (enabled && !was) {
        // Every repository on the connection, paused ones included: pausing
        // never removed a hook.
        const repos = await db
          .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
          .from(core.repos)
          .where(
            and(eq(core.repos.workspaceId, ctx.workspaceId), eq(core.repos.connectionId, row.id)),
          );
        const out = await removeHooks(row, repos);
        webhooksRemoved = out.removed;
        failures.push(...out.failures);
      } else if (!enabled && was) {
        const secret = openWebhookSecret(row);
        const repos = await db
          .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
          .from(core.repos)
          .where(
            and(
              eq(core.repos.workspaceId, ctx.workspaceId),
              eq(core.repos.connectionId, row.id),
              sql`${core.repos.syncStatus} <> 'paused'`,
            ),
          );
        // No secret means nothing was ever tracked on it: the next track call
        // makes one and registers hooks as usual.
        if (secret !== null && repos.length > 0) {
          const out = await registerHooks(row, repos, secret, ctx.workspaceId);
          webhooksRegistered = out.registered;
          failures.push(...out.failed.map((f) => ({ repo: f.repo, error: f.error })));
        }
      }
      const list = await setConnectionScheduledOnly(db, ctx.workspaceId, row.id, enabled);

      auditLog(request.log, {
        event: 'connection.scheduled_sync_only',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        enabled,
        webhooksRemoved,
        webhooksRegistered,
        webhookFailures: failures.length,
      });
      return reply.send({
        id: row.id,
        scheduled_sync_only: list.includes(row.id),
        webhooks_removed: webhooksRemoved,
        webhooks_registered: webhooksRegistered,
        webhook_failures: failures,
      });
    },
  );

  // PUT /connections/{id}/auto-add — track this connection's NEW repositories
  // automatically, or stop doing so (👑) (W20-17, UX_TODO INS-09). Discovery
  // runs in the nightly reconcile sweep through the budgeted client; turning
  // it off never untracks anything already tracked.
  typedApp.put(
    '/connections/:id/auto-add',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: autoAddBodySchema,
        response: { 200: autoAddResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const row = await loadConnection(request.params.id, ctx.workspaceId);
      if (!row) return fail(request, reply, 404, 'Not Found');
      if (request.body.enabled && row.status !== 'active') return removedConnection(request, reply);
      const list = await setConnectionAutoAdd(db, ctx.workspaceId, row.id, request.body.enabled);
      auditLog(request.log, {
        event: 'connection.auto_add',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        enabled: request.body.enabled,
      });
      return reply.send({ id: row.id, auto_add: list.includes(row.id) });
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
  // The push webhooks it registered are deleted on the forge first (W20-17);
  // any that cannot be are listed in the response, and with the secret gone
  // every delivery they still send is refused with 401.
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

      // W20-17: remove the push hooks this connection registered BEFORE the
      // credential is wiped (afterwards nothing could authenticate the
      // delete). Matched by delivery URL, like deploy/uninstall.sh (X-27), one
      // repository at a time through the budgeted provider (Law 7). Paused
      // repositories are included: pausing never removed their hook. A
      // failure is reported, never fatal: the person asked to remove the
      // connection, and an orphan hook only collects refused deliveries.
      const hookRepos = await db
        .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
        .from(core.repos)
        .where(
          and(eq(core.repos.workspaceId, ctx.workspaceId), eq(core.repos.connectionId, row.id)),
        );
      let webhooksRemoved = 0;
      const webhookFailures: HookFailure[] = [];
      if (row.status === 'active' && hookRepos.length > 0) {
        const out = await removeHooks(row, hookRepos);
        webhooksRemoved = out.removed;
        webhookFailures.push(...out.failures);
      }

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

      // A removed connection discovers nothing; drop its auto-add choice. A
      // re-keyed one starts with webhooks again, so scheduled-only goes too.
      await setConnectionAutoAdd(db, ctx.workspaceId, row.id, false);
      await setConnectionScheduledOnly(db, ctx.workspaceId, row.id, false);

      auditLog(request.log, {
        event: 'connection.removed',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        connectionId: row.id,
        outcome: outcome.outcome,
        pausedRepos: outcome.paused,
        webhooksRemoved,
        webhookFailures: webhookFailures.length,
      });
      return reply.send({
        id: row.id,
        outcome: outcome.outcome,
        paused_repos: outcome.paused,
        webhooks_removed: webhooksRemoved,
        webhook_failures: webhookFailures,
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

      // W20-14 (UX_TODO INS-30): an `error` repo is retried the same way — a
      // fresh plan from its cursors, what the nightly sweep does for it —
      // instead of waiting for 03:17.
      if (repo.syncStatus !== 'paused' && repo.syncStatus !== 'error') {
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

  // POST /repos/{id}/sync-now — catch one live repository up now (👑)
  // (W20-22, UX_TODO INS-30). The nightly reconcile pass, for one repository,
  // through the same budgeted client: it repairs what a missed webhook left
  // behind. Only for `live`: an errored repository has Retry (a fresh plan),
  // a paused one Resume, and one still loading its history is syncing already.
  typedApp.post(
    '/repos/:id/sync-now',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        response: { 202: syncNowResponseSchema },
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
      if (repo.connectionStatus !== 'active') {
        return fail(
          request,
          reply,
          409,
          'Its connection was removed',
          'Replace the connection’s token in Settings → Connections first.',
        );
      }
      if (repo.syncStatus !== 'live') {
        const detail =
          repo.syncStatus === 'error'
            ? 'Use Retry: it plans the sync again from where it stopped.'
            : repo.syncStatus === 'paused'
              ? 'It is paused. Resume it to start syncing again.'
              : 'It is still loading its history and syncs as it goes.';
        return fail(request, reply, 409, 'Sync now is for a repository that is up to date', detail);
      }
      if (!opts.enqueueReconcile) {
        return fail(request, reply, 503, 'The sync queue is not available on this server');
      }
      await opts.enqueueReconcile({ workspaceId: ctx.workspaceId, repoId: repo.id });
      auditLog(request.log, {
        event: 'repo.sync_requested',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        repoId: repo.id,
      });
      return reply.code(202).send({ repo_id: repo.id, queued: true as const });
    },
  );

  // DELETE /repos/{id} — stop tracking a repository AND delete its stored
  // history (👑) (W20-19, UX_TODO INS-09; decision 2026-10-20).
  //
  // Pause stays the default way to stop tracking: it keeps every chart. This
  // is the other one, behind a typed confirmation: the body must carry the
  // repository's `org/name` exactly. Its push hook is removed on the forge
  // first (deleteWebhooks, while the connection can still authenticate), then
  // every workspace-scoped row about it is deleted in one transaction (see
  // lib/purge-repo.ts for what is kept and why). A repository whose code was
  // ever sent to an off-network model is refused: that record is append-only.
  typedApp.delete(
    '/repos/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: connectionIdParamsSchema,
        body: purgeRepoBodySchema,
        response: { 200: purgeRepoResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');
      const [repo] = await db
        .select({
          id: core.repos.id,
          workspaceId: core.repos.workspaceId,
          connectionId: core.repos.connectionId,
          forgeRepoId: core.repos.forgeRepoId,
          org: core.repos.org,
          name: core.repos.name,
        })
        .from(core.repos)
        .where(
          and(eq(core.repos.id, request.params.id), eq(core.repos.workspaceId, ctx.workspaceId)),
        )
        .limit(1);
      // Tenancy (Law 5): another workspace's repository is a 404.
      if (!repo) return fail(request, reply, 404, 'Not Found');
      const fullName = `${repo.org}/${repo.name}`;
      if (request.body.confirm.trim() !== fullName) {
        return fail(
          request,
          reply,
          400,
          'Type the repository name to confirm',
          `Type ${fullName} exactly to delete its history. To stop syncing and keep the history, pause it instead.`,
        );
      }
      const egress = await egressRecordCount(db, repo);
      if (egress > 0) {
        return fail(
          request,
          reply,
          409,
          'This repository’s history cannot be deleted',
          `Its code was sent to an off-network model ${egress} time${egress === 1 ? '' : 's'}, and that record is kept for good (it cannot be edited or deleted). Pause the repository instead.`,
        );
      }

      // The hook first, while the connection still has its credential. A
      // failure is reported, not fatal, exactly as DELETE /connections does.
      let webhooksRemoved = 0;
      const webhookFailures: HookFailure[] = [];
      const conn = await loadConnection(repo.connectionId, ctx.workspaceId);
      if (conn && conn.status === 'active') {
        const out = await removeHooks(conn, [repo]);
        webhooksRemoved = out.removed;
        webhookFailures.push(...out.failures);
      }

      const counts = await db.transaction((tx) => purgeRepoHistory(tx, repo, ctx.userId));
      // "Auto-add new" must not track it again tonight.
      const { stored } = await readWorkspaceSettings(db, ctx.workspaceId);
      if ((stored.auto_add_connection_ids ?? []).includes(repo.connectionId)) {
        await skipAutoAdd(db, ctx.workspaceId, repo.connectionId, repo.forgeRepoId);
      }

      auditLog(request.log, {
        event: 'repo.purged',
        actorUserId: ctx.userId,
        ...auditContext(request, ctx.workspaceId),
        repoId: repo.id,
        // The name, because after this there is no row to resolve the id with.
        repo: fullName,
        connectionId: repo.connectionId,
        deleted: counts.deleted,
        narrowed: counts.narrowed,
        ciTokensRevoked: counts.ciTokensRevoked,
        webhooksRemoved,
        webhookFailures: webhookFailures.length,
      });
      return reply.send({
        repo_id: repo.id,
        repo: fullName,
        purged: true as const,
        deleted: counts.deleted,
        narrowed: counts.narrowed,
        ci_tokens_revoked: counts.ciTokensRevoked,
        webhooks_removed: webhooksRemoved,
        webhook_failures: webhookFailures,
      });
    },
  );
}
