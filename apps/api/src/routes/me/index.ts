import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, type Database } from '@repopulse/shared';
import { identity } from '@repopulse/auth';
import { prSizeBucket } from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';

// Personalized widgets (FR-AUTH-6, FR-WEB-7). Each resolves the logged-in user
// → their forge author identity (identity map) and filters warehouse rows by
// it. A user with no ingested authorship yet resolves to null → empty results
// (never an error). N-9: person-grain data is the caller's OWN only (D6).

export interface MeRoutesOptions {
  db: Database;
  /**
   * W13-02. True when the API is serving a fake forge and a mocked login, so
   * the shell can say so. Comes from the SERVER, not a browser env flag: the
   * browser cannot know what the API it is talking to is actually connected to,
   * and a demo that looks identical to the real product is how a screenshot of
   * fixture data ends up in a decision meeting.
   */
  demo?: boolean;
}

// UX_SPEC §6 personas and the home each one routes to (D9/R-A2). The mapping
// lives here, not in the browser: "which screen is this persona's home" is a
// product decision the API already owns via default_view_id, and duplicating it
// client-side is how the two drift.
export const PERSONAS = ['lead', 'developer', 'security', 'exec'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERSONA_HOME: Record<Persona, string> = {
  lead: '/', // P1 → Org Overview
  developer: '/me', // P2 → My Focus
  security: '/findings', // P3 → Findings Explorer
  exec: '/reports', // P4 → Exec rollup lives under Reports until W5's views
};

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

export default async function meRoutes(app: FastifyInstance, opts: MeRoutesOptions): Promise<void> {
  const { db } = opts;

  async function myIdentity(
    request: FastifyRequest,
  ): Promise<{ workspaceId: number; identityId: number | null } | null> {
    const userId = request.session.get('userId');
    const workspaceId = request.workspace?.id;
    if (userId === undefined || workspaceId === undefined) return null;
    const identityId = await identity.resolveUserIdentity(db, workspaceId, userId);
    return { workspaceId, identityId };
  }

  async function readUser(
    request: FastifyRequest,
  ): Promise<{ persona: string | null; prefs: Record<string, unknown> } | null> {
    const userId = request.session.get('userId');
    if (userId === undefined) return null;
    const [row] = await db
      .select({ persona: core.users.persona, prefs: core.users.prefs })
      .from(core.users)
      .where(eq(core.users.id, userId))
      .limit(1);
    return row ?? null;
  }

  // GET /api/v1/me/context — who am I, where, and with what role (W4-14).
  //
  // The documented contract also lives at top-level /me (API_DESIGN.md §2), but
  // the SPA cannot reach it: client.ts only ever builds /api/v1 URLs (Law 4) and
  // the dev proxy forwards /api and /auth, not /me. So the app-facing copy lives
  // here, where it is strictly MORE correct — inside api-v1 the guard has
  // already resolved workspace and role onto the request, so this returns the
  // exact values the guard enforces without re-querying. Divergence between the
  // role the UI renders and the role the guard applies is impossible here by
  // construction, which is not a claim a second lookup could make.
  app.get('/me/context', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx || request.workspace === undefined || request.role === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const me = await readUser(request);
    return reply.send({
      workspace: {
        id: request.workspace.id,
        slug: request.workspace.slug,
        name: request.workspace.name,
      },
      role: request.role,
      identity_id: ctx.identityId,
      default_view_id: null, // W5-02 owns saved views.
      // W4-10 (UX_SPEC §6). NULL persona = never asked, which is what opens the
      // picker. Sent as part of the context the shell already fetches rather
      // than as its own request: a separate call would make the picker race the
      // first paint and flash the wrong home.
      persona: me?.persona ?? null,
      prefs: me?.prefs ?? {},
      demo: opts.demo ?? false,
    });
  });

  /** PATCH /me/persona — set or change it (first login, or the user menu). */
  app.patch<{ Body: { persona?: unknown } }>('/me/persona', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId === undefined) return fail(request, reply, 401, 'No active session');
    const persona = request.body?.persona;
    if (typeof persona !== 'string' || !PERSONAS.includes(persona as Persona)) {
      return fail(request, reply, 400, `persona must be one of ${PERSONAS.join(', ')}`);
    }
    const [row] = await db
      .update(core.users)
      .set({ persona })
      .where(eq(core.users.id, userId))
      .returning({ persona: core.users.persona });
    if (!row) return fail(request, reply, 404, 'User not found');
    return reply.send({ persona: row.persona, home: PERSONA_HOME[persona as Persona] });
  });

  /** PATCH /me/prefs — merge per-user UI state (onboarding dismissal). */
  app.patch<{ Body: Record<string, unknown> }>('/me/prefs', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId === undefined) return fail(request, reply, 401, 'No active session');
    const patch = request.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return fail(request, reply, 400, 'prefs must be an object');
    }
    // MERGE, like workspace settings: this column will hold more than one
    // preference, and a replace would drop whatever the caller did not send.
    const [existing] = await db
      .select({ prefs: core.users.prefs })
      .from(core.users)
      .where(eq(core.users.id, userId))
      .limit(1);
    if (!existing) return fail(request, reply, 404, 'User not found');
    const [row] = await db
      .update(core.users)
      .set({ prefs: { ...existing.prefs, ...patch } })
      .where(eq(core.users.id, userId))
      .returning({ prefs: core.users.prefs });
    return reply.send({ prefs: row!.prefs });
  });

  // GET /me/prs — PRs I authored.
  app.get('/me/prs', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        repoId: facts.pullRequests.repoId,
        state: facts.pullRequests.state,
        additions: facts.pullRequests.additions,
        deletions: facts.pullRequests.deletions,
        createdAt: facts.pullRequests.createdAt,
        mergedAt: facts.pullRequests.mergedAt,
      })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.authorIdentityId, ctx.identityId))
      .orderBy(desc(facts.pullRequests.updatedAt));
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        state: p.state,
        size_bucket: prSizeBucket(p.additions + p.deletions),
        opened_at: p.createdAt.toISOString(),
        merged_at: p.mergedAt?.toISOString() ?? null,
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/review-queue — open PRs awaiting review that I did NOT author (age-sorted).
  app.get('/me/review-queue', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        repoId: facts.pullRequests.repoId,
        createdAt: facts.pullRequests.createdAt,
        author: core.identities.forgeLogin,
      })
      .from(facts.pullRequests)
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .where(
        and(
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.state, 'open'),
          ne(facts.pullRequests.authorIdentityId, ctx.identityId),
        ),
      )
      .orderBy(facts.pullRequests.createdAt); // oldest first (age-sorted review load)
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        author: p.author,
        opened_at: p.createdAt.toISOString(),
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/hotspots — files I own that are hot (my churn share of the file).
  app.get('/me/hotspots', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        repoId: facts.commitFiles.repoId,
        path: facts.commitFiles.path,
        myLines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .where(
        and(
          eq(facts.commitFiles.workspaceId, ctx.workspaceId),
          eq(facts.commits.authorIdentityId, ctx.identityId),
          eq(facts.commits.isMerge, false),
        ),
      )
      .groupBy(facts.commitFiles.repoId, facts.commitFiles.path)
      .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`))
      .limit(50);
    return reply.send({
      items: rows.map((r) => ({
        repo_id: r.repoId,
        path: r.path,
        my_lines: r.myLines ?? 0,
        links: { file: `/api/v1/repos/${r.repoId}/files/${encodeURIComponent(r.path)}` },
      })),
    });
  });

  // GET /me/stats — my own PR size/cycle stats (own data only, N-9).
  app.get('/me/stats', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ merged_prs: 0, median_size: null });
    const [row] = await db
      .select({
        mergedCount: sql<number>`count(*) filter (where ${facts.pullRequests.mergedAt} is not null)::int`,
        medianSize: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${facts.pullRequests.additions} + ${facts.pullRequests.deletions}) filter (where ${facts.pullRequests.mergedAt} is not null)`,
      })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.authorIdentityId, ctx.identityId));
    return reply.send({ merged_prs: row?.mergedCount ?? 0, median_size: row?.medianSize ?? null });
  });
}
