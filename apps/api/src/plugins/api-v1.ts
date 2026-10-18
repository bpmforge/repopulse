import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { workspace as workspaceModule } from '@repopulse/auth';
import { sendProblem } from '../lib/problem.js';
import '../lib/rbac.js';
import { bearerFrom, resolveCiToken } from '../lib/ci-token.js';
import type { RequestWorkspace } from '../lib/rbac.js';
import viewsRoutes from '../routes/views/index.js';
import metricsRoutes from '../routes/metrics/index.js';
import orgRoutes from '../routes/org/index.js';
import hotspotsRoutes from '../routes/hotspots/index.js';
import reposRoutes from '../routes/repos/index.js';
import prsRoutes from '../routes/prs/index.js';
import filesRoutes from '../routes/files/index.js';
import meRoutes from '../routes/me/index.js';
import eventsRoutes from '../routes/events/index.js';
import connectionsRoutes, { type ConnectionsRoutesOptions } from '../routes/connections/index.js';
import syncRoutes from '../routes/sync/index.js';
import adminRoutes from '../routes/admin/index.js';
import identityRoutes from '../routes/admin/identities/index.js';
import reportsRoutes from '../routes/reports/index.js';
import plansRoutes from '../routes/plans/index.js';
import findingsRoutes from '../routes/findings/index.js';
import patchRoutes from '../routes/patches/index.js';
import intentsRoutes from '../routes/intents/index.js';
import analysisAdminRoutes from '../routes/admin/analysis/index.js';
import llmProviderRoutes from '../routes/admin/llm-providers/index.js';
import llmRoutingRoutes from '../routes/admin/llm-routing/index.js';
import runRoutes from '../routes/runs/index.js';
import scannersRoutes from '../routes/scanners/index.js';
import securityRoutes from '../routes/security/index.js';
import sensitiveChangesRoutes from '../routes/security/sensitive-changes.js';
// W11-02: the setup status endpoints (admin only, values never returned).
import setupRoutes from '../routes/setup/index.js';
import codeHealthRoutes from '../routes/code-health/index.js';
import rulesRoutes from '../routes/rules/index.js';
// W18-22: per-rule precision and the repository coverage map.
import trustRoutes from '../routes/trust/index.js';
import riskRoutes from '../routes/risk/index.js';
import agreementsRoutes from '../routes/agreements/index.js';
import workspaceRoutes from '../routes/admin/workspace/index.js';
import pullsRoutes from '../routes/pulls/index.js';
import ciTokenRoutes from '../routes/admin/ci-tokens/index.js';
import systemRoutes from '../routes/admin/system/index.js';

export interface ApiV1Options {
  db: Database;
  /** Threaded through for the SSE relay's dedicated Redis subscriber. */
  redisUrl: string;
  /** AES key for forge credentials at rest (FR-AUTH-5). */
  tokenKey: Buffer;
  /** Absolute webhook URL surfaced when a connection is created. */
  webhookUrl: string;
  enqueueBackfillPlan: (params: { workspaceId: number; repoId: number }) => Promise<void>;
  /**
   * Forwarded to the connections route, which already documents it as an
   * injectable seam. Exposed here so tests exercise the REAL mount rather than
   * registering a second copy of the route beside it — the duplicate was how
   * these suites passed while production served nothing.
   */
  buildProvider?: ConnectionsRoutesOptions['buildProvider'];
  /** Forge API base URL (GHES / self-hosted forge, or a fake in e2e). */
  forgeBaseUrl?: string;
  adminQueueFor?: (queue: string) => import('bullmq').Queue | undefined;
  /** W13-02: surfaced to the SPA on /me/context so the UI can say it is a demo. */
  demo?: boolean;
  /** W5-04: enqueue a report generation (reports.generate). */
  enqueueReport?: (data: {
    reportId: number;
    workspaceId: number;
    params: import('@repopulse/reports').ReportParams;
  }) => Promise<void>;
  /** W5-09: repeatable-job seam for scheduled generation. */
  schedules?: import('../routes/reports/index.js').ReportsRoutesOptions['schedules'];
}

// The guarded /api/v1 scope (API_DESIGN.md §1/§2): session required,
// workspace resolved + auto-membership (FR-AUTH-3), role attached for
// requireAdmin (FR-AUTH-4). NOT fastify-plugin-wrapped on purpose — this
// must stay its own encapsulation boundary so /auth/*, /healthz and
// /api/v1/openapi.json (registered as siblings in app.ts) stay exempt.
//
// Future feature-route tickets: register your route plugin AS A CHILD of
// this plugin (nest the app.register call inside this function body, or
// extend it) to inherit the session/workspace/role preHandler and the zod
// validator/serializer compilers below — registering alongside it at the
// top level under the same '/api/v1' prefix string does NOT inherit them.
async function workspaceById(db: Database, id: number): Promise<RequestWorkspace> {
  const [ws] = await db
    .select({ id: core.workspaces.id, slug: core.workspaces.slug, name: core.workspaces.name })
    .from(core.workspaces)
    .where(eq(core.workspaces.id, id))
    .limit(1);
  // The FK makes a missing row impossible while the token row exists.
  if (!ws) throw new Error(`ci token names workspace ${id}, which does not exist`);
  return ws;
}

export default async function apiV1(app: FastifyInstance, opts: ApiV1Options): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // W18-18: a customer-CI token instead of a session. Decided in onRequest —
  // BEFORE body parsing and zod validation, so a token aimed at a route it may
  // not call is refused outright rather than first told what its payload got
  // wrong — and decided EXCLUSIVELY: a request carrying an Authorization header
  // is judged as a token request and nothing else, so a browser cookie riding
  // along cannot lift a CI token's request into a member's.
  app.addHook('onRequest', async (request, reply) => {
    const bearer = bearerFrom(request.headers.authorization);
    if (bearer === null) return undefined;
    const resolved = bearer === '' ? null : await resolveCiToken(opts.db, bearer);
    if (!resolved) {
      sendProblem(request, reply, 401, 'Invalid, expired or revoked token');
      return reply;
    }
    // Opt-in per route AND read-only per method. The method check is
    // belt-and-braces: no route carrying the flag is a write today, and one
    // that became one by accident must still refuse a token.
    const wanted = request.routeOptions.config.ciToken;
    const readMethod = request.method === 'GET' || request.method === 'HEAD';
    if (!wanted || wanted.scope !== resolved.scope || !readMethod) {
      sendProblem(request, reply, 403, 'This token cannot call this endpoint', {
        detail: `A CI token carries the read-only scope ${resolved.scope} and can only read pull-request findings.`,
      });
      return reply;
    }
    request.ciToken = resolved;
    request.workspace = await workspaceById(opts.db, resolved.workspaceId);
    // No role: a token is not a member. requireAdmin refuses undefined, and
    // no route a token can reach reads one.
    return undefined;
  });

  // Explicitly `return reply` on the early-exit path — Fastify's
  // short-circuit detection between chained preHandlers (this plugin-level
  // hook + a route's own preHandler, e.g. requireAdmin) isn't reliable off
  // `reply.sent` alone with a bare `return`; verified empirically
  // (api-v1.test.ts caught a real double-onSend/double-session-save
  // otherwise — see rbac.ts's requireAdmin for the same fix).
  app.addHook('preHandler', async (request, reply) => {
    // Authenticated by token in onRequest; the session is not consulted.
    if (request.ciToken) return undefined;
    const userId = request.session?.get('userId');
    if (userId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }
    let membership;
    try {
      membership = await workspaceModule.ensureMembership(opts.db, userId);
    } catch (err) {
      // The session names a user that no longer exists (W16-15). That is a
      // DEAD SESSION, not a server fault: answer 401 and destroy it, so the
      // shell routes to the sign-in screen instead of retrying a 500 for ever.
      if (err instanceof workspaceModule.UnknownUserError) {
        request.log.info(
          { userId, audit: true, event: 'auth.session.orphaned' },
          'session names a deleted user — destroying it',
        );
        await request.session?.destroy?.();
        sendProblem(request, reply, 401, 'No active session');
        return reply;
      }
      throw err;
    }
    request.workspace = {
      id: membership.workspace.id,
      slug: membership.workspace.slug,
      name: membership.workspace.name,
    };
    request.role = membership.role;
    return undefined;
  });

  // W5-01: first real feature route registered as a child of this plugin,
  // per the HANDOFF comment above — inherits the session/workspace/role
  // preHandler and the zod validator/serializer compilers set on `app`.
  await app.register(viewsRoutes, { db: opts.db });

  // W4-02: the W3-12 (metrics read) + W4-01 (drill-down/personal) route
  // plugins were authored and tested but never registered in the production
  // app — their contract tests mount them into a throwaway apiV1 scope, so
  // the omission was invisible. Mount them here (same child pattern) so the
  // read API the web shell consumes is actually served and appears in the
  // OpenAPI document the typed client is generated from. Webhooks (raw-body,
  // unauthenticated sibling) + admin connections/sync stay unmounted — different
  // auth surface, their own later tickets.
  await app.register(metricsRoutes, { db: opts.db });
  await app.register(orgRoutes, { db: opts.db });
  await app.register(hotspotsRoutes, { db: opts.db });
  await app.register(reposRoutes, { db: opts.db });
  await app.register(prsRoutes, { db: opts.db });
  await app.register(filesRoutes, { db: opts.db });
  await app.register(meRoutes, { db: opts.db, demo: opts.demo ?? false });
  // SSE, mounted at last. It was deferred because inject() hangs on a
  // socket-hijacking route and stalled the W1-07 tenancy walker; the walker now
  // skips streaming prefixes explicitly, and this route carries its own
  // cross-workspace isolation test in place of the sweep it no longer joins.
  // Tenancy here is by construction: the Redis channel name is derived from the
  // workspace this plugin's guard already resolved, so a client cannot ask for
  // another tenant's stream.
  await app.register(eventsRoutes, { redisUrl: opts.redisUrl });
  // Admin surface: connecting an org and watching sync. Both existed and were
  // tested since W2 but were never mounted, so docs/INSTALL.md told operators to
  // visit a screen backed by routes the server did not serve.
  await app.register(connectionsRoutes, {
    db: opts.db,
    tokenKey: opts.tokenKey,
    webhookUrl: opts.webhookUrl,
    enqueueBackfillPlan: opts.enqueueBackfillPlan,
    ...(process.env.GITHUB_APP_ID ? { appId: process.env.GITHUB_APP_ID } : {}),
    ...(opts.buildProvider ? { buildProvider: opts.buildProvider } : {}),
    ...(opts.forgeBaseUrl ? { forgeBaseUrl: opts.forgeBaseUrl } : {}),
  });
  await app.register(syncRoutes, { db: opts.db });
  // Members + DLQ inspect/replay (W4-20). The DLQ half matters most: W12-05
  // made the dead-letter queue a deliberate SINK so a human could inspect and
  // replay, and until this was mounted there was no way to do the inspecting.
  await app.register(adminRoutes, {
    db: opts.db,
    ...(opts.redisUrl ? { redisUrl: opts.redisUrl } : {}),
    ...(opts.adminQueueFor ? { queueFor: opts.adminQueueFor } : {}),
  });
  // Report Center (W5-04). enqueueReport is threaded from app.ts so the route
  // can queue a generation without owning a Redis connection.
  await app.register(reportsRoutes, {
    db: opts.db,
    ...(opts.enqueueReport ? { enqueueReport: opts.enqueueReport } : {}),
    ...(opts.schedules ? { schedules: opts.schedules } : {}),
  });
  // Scanner enablement (W8-01).
  await app.register(scannersRoutes, { db: opts.db });
  // W17-07: read-only install health. Registered here rather than beside
  // /healthz because it is admin-only and workspace-scoped.
  await app.register(systemRoutes, { db: opts.db, redisUrl: opts.redisUrl });
  await app.register(securityRoutes, { db: opts.db });
  // W18-29: the sensitive-change radar's screen.
  await app.register(sensitiveChangesRoutes, { db: opts.db });
  await app.register(setupRoutes, { db: opts.db });
  await app.register(codeHealthRoutes, { db: opts.db });
  await app.register(rulesRoutes, { db: opts.db });
  await app.register(trustRoutes, { db: opts.db });
  await app.register(riskRoutes, { db: opts.db });
  // Admin Analysis (W7-08).
  await app.register(analysisAdminRoutes, { db: opts.db });
  // W16-07: the configuration surface for bring-your-own-LLM. Needs tokenKey —
  // provider API keys go through the same vault as forge tokens (Law 9).
  await app.register(llmProviderRoutes, { db: opts.db, tokenKey: opts.tokenKey });
  await app.register(llmRoutingRoutes, { db: opts.db });
  // W16-10 (F15): nothing in this product could be started by hand until now.
  await app.register(runRoutes, { db: opts.db, redisUrl: opts.redisUrl });
  // Artifact intents (W6-07).
  await app.register(intentsRoutes, { db: opts.db });
  // Findings (W6-04).
  await app.register(findingsRoutes, { db: opts.db });
  // Verified patches (W18-19, D16): drafted, re-scanned, handed to a person —
  // never written to the forge (D9a).
  await app.register(patchRoutes, { db: opts.db, redisUrl: opts.redisUrl });
  // Working agreements (W5-08).
  await app.register(agreementsRoutes, { db: opts.db });
  // Improvement plans (W5-06).
  await app.register(plansRoutes, { db: opts.db });
  // Identity admin (W5-05) — merging decides WHO the ownership and bus-factor
  // numbers are about, so it sits beside the settings that decide what they mean.
  await app.register(identityRoutes, { db: opts.db });
  // Workspace settings (W4-09) — the weights, bot list and stale-N that decide
  // what every other number on every screen means.
  await app.register(workspaceRoutes, { db: opts.db });
  // W18-18 (D16 CI pull): the customer's CI reads what a PR introduced, with a
  // read-only token minted by an admin. The only routes a CI token can reach.
  await app.register(pullsRoutes, { db: opts.db });
  await app.register(ciTokenRoutes, { db: opts.db });
}
