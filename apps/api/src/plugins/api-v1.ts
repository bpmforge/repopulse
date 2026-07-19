import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
import { workspace as workspaceModule } from '@repopulse/auth';
import { sendProblem } from '../lib/problem.js';
import '../lib/rbac.js';
import viewsRoutes from '../routes/views/index.js';
import metricsRoutes from '../routes/metrics/index.js';
import orgRoutes from '../routes/org/index.js';
import hotspotsRoutes from '../routes/hotspots/index.js';
import reposRoutes from '../routes/repos/index.js';
import prsRoutes from '../routes/prs/index.js';
import filesRoutes from '../routes/files/index.js';
import meRoutes from '../routes/me/index.js';

export interface ApiV1Options {
  db: Database;
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
export default async function apiV1(app: FastifyInstance, opts: ApiV1Options): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Explicitly `return reply` on the early-exit path — Fastify's
  // short-circuit detection between chained preHandlers (this plugin-level
  // hook + a route's own preHandler, e.g. requireAdmin) isn't reliable off
  // `reply.sent` alone with a bare `return`; verified empirically
  // (api-v1.test.ts caught a real double-onSend/double-session-save
  // otherwise — see rbac.ts's requireAdmin for the same fix).
  app.addHook('preHandler', async (request, reply) => {
    const userId = request.session?.get('userId');
    if (userId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }
    const membership = await workspaceModule.ensureMembership(opts.db, userId);
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
  // OpenAPI document the typed client is generated from. Deferred by W4-02:
  // GET /api/v1/events (SSE). The real prerequisite is NOT "wire redisUrl" — it's
  // that the W1-07 tenancy route-walker has no streaming-route exemption, so ANY
  // mount of a socket-hijacking route hangs `walkForTenancyLeakage` (it injects
  // and waits for a response that never ends). Mounting /events requires teaching
  // the walker to skip SSE/streaming routes first; until then the web SSE client
  // (unit-tested against a mock) has no live endpoint. Webhooks (raw-body,
  // unauthenticated sibling) + admin connections/sync also stay unmounted —
  // different auth surface, their own later tickets.
  await app.register(metricsRoutes, { db: opts.db });
  await app.register(orgRoutes, { db: opts.db });
  await app.register(hotspotsRoutes, { db: opts.db });
  await app.register(reposRoutes, { db: opts.db });
  await app.register(prsRoutes, { db: opts.db });
  await app.register(filesRoutes, { db: opts.db });
  await app.register(meRoutes, { db: opts.db });
}
