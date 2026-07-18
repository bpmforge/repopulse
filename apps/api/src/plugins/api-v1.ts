import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
import { workspace as workspaceModule } from '@repopulse/auth';
import { sendProblem } from '../lib/problem.js';
import '../lib/rbac.js';
import viewsRoutes from '../routes/views/index.js';

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
}
