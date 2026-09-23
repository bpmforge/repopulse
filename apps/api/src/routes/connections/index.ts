import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { core, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { activateRepos, createConnection, ConnectValidationError } from '@repopulse/ingest';
import {
  ForgeHttpError,
  splitRepoFullName,
  type CallCtx,
  type ForgeProvider,
  type GitHubAuth,
} from '@repopulse/forge';
import { sendProblem } from '../../lib/problem.js';
import { requireAdmin } from '../../lib/rbac.js';
import { buildDiscoveryProvider, type ForgeKind } from './provider-factory.js';
import {
  availableReposResponseSchema,
  connectionIdParamsSchema,
  connectionListResponseSchema,
  createConnectionBodySchema,
  createConnectionResponseSchema,
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
    return buildProvider(
      authFor(row.authKind as 'pat' | 'app', credential, row.appInstallationId ?? undefined),
      row.provider as ForgeKind,
      row.baseUrl ?? undefined,
    );
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
      const baseUrl = base_url ?? opts.forgeBaseUrl;
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
          // Distinct, actionable: bad_token / bad_scope / no_repos.
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
          last4: credentials.fingerprintLast4(r.fingerprint),
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
      const [row] = await db
        .select()
        .from(core.forgeConnections)
        .where(eq(core.forgeConnections.id, request.params.id))
        .limit(1);
      if (!row || row.workspaceId !== ctx.workspaceId)
        return fail(request, reply, 404, 'Not Found');

      const forge = await providerForConnection(row);
      let repos: Awaited<ReturnType<typeof forge.listRepos>>;
      try {
        repos = await forge.listRepos(CTX);
      } catch (err) {
        // W17-35: the adapters reject on an HTTP error rather than returning an
        // empty list, so say what the forge answered instead of a bare 500.
        if (err instanceof ForgeHttpError) {
          return fail(request, reply, 502, 'The forge refused the repository listing', err.message);
        }
        throw err;
      }
      return reply.send({
        items: repos.items.map((r) => {
          const { org, name } = splitRepoFullName(r.fullName, r.name);
          return {
            forge_repo_id: r.externalId,
            org,
            name,
            is_private: r.isPrivate,
            is_archived: r.isArchived,
          };
        }),
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
      const [row] = await db
        .select()
        .from(core.forgeConnections)
        .where(eq(core.forgeConnections.id, request.params.id))
        .limit(1);
      if (!row || row.workspaceId !== ctx.workspaceId)
        return fail(request, reply, 404, 'Not Found');

      const forge = await providerForConnection(row);
      let listed: Awaited<ReturnType<typeof forge.listRepos>>;
      try {
        listed = await forge.listRepos(CTX);
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
}
