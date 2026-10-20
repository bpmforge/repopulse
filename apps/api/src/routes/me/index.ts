import { and, desc, eq, gt, gte, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, read, security, type Database } from '@repopulse/shared';
import { identity, workspace as workspaceModule } from '@repopulse/auth';
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
/** The "Files I've changed most" window (W20-12, UX_TODO DSH-88). */
const MY_FILES_DAYS = 90;

export const PERSONAS = ['lead', 'developer', 'security', 'exec', 'admin'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERSONA_HOME: Record<Persona, string> = {
  lead: '/', // P1 → Org Overview
  developer: '/me', // P2 → My Focus
  security: '/findings', // P3 → Findings Explorer
  exec: '/reports', // P4 → Exec rollup lives under Reports until W5's views
  // W20-17 (UX_TODO INS-16): the person who runs the install. A home screen,
  // not a permission: a member who picks it meets the ask-an-admin page.
  admin: '/admin/setup',
};

/** A first look at the inbox shows a week, not every finding ever recorded. */
const INBOX_FIRST_LOOK_MS = 7 * 24 * 60 * 60 * 1000;
/** The panel lists the newest few of each kind; the counts carry the rest. */
const INBOX_ITEMS = 20;

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

  async function readUser(request: FastifyRequest): Promise<{
    persona: string | null;
    prefs: Record<string, unknown>;
    login: string;
    email: string | null;
  } | null> {
    const userId = request.session.get('userId');
    if (userId === undefined) return null;
    const [row] = await db
      .select({
        persona: core.users.persona,
        prefs: core.users.prefs,
        login: core.users.login,
        email: core.users.email,
      })
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
    // W20-05 (UX_TODO DSH-03). This was a literal null, so "Set as home"
    // stored a choice nothing could read back. Workspace- and owner-filtered:
    // only YOUR default in THIS workspace (Law 5).
    const userId = request.session.get('userId');
    const [defaultView] =
      userId === undefined
        ? []
        : await db
            .select({ id: read.savedViews.id })
            .from(read.savedViews)
            .where(
              and(
                eq(read.savedViews.workspaceId, request.workspace.id),
                eq(read.savedViews.ownerUserId, userId),
                eq(read.savedViews.isDefaultForOwner, true),
              ),
            )
            .limit(1);
    const persona = (me?.persona ?? null) as Persona | null;
    // W20-17 (UX_TODO INS-16, INS-17, INS-36): first-run surfaces need to know
    // whether the workspace tracks anything yet. Workspace-filtered (Law 5).
    const [tracked] = await db
      .select({
        n: sql<number>`count(*)::int`,
        live: sql<number>`(count(*) filter (where ${core.repos.syncStatus} = 'live'))::int`,
      })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, request.workspace.id));
    // INS-39: the onboarding steps tick from data ("Assign workspace roles"
    // once anyone else is a member).
    const [members] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(core.workspaceMembers)
      .where(eq(core.workspaceMembers.workspaceId, request.workspace.id));
    return reply.send({
      workspace: {
        id: request.workspace.id,
        slug: request.workspace.slug,
        name: request.workspace.name,
      },
      role: request.role,
      // W20-04 (UX_TODO ADM-11): Members needs to know which row is the
      // caller, to warn an admin before they demote themselves.
      user_id: request.session.get('userId'),
      // W20-17 (UX_TODO ADM-54): who you are signed in as, for the user menu.
      login: me?.login ?? null,
      email: me?.email ?? null,
      repo_count: tracked?.n ?? 0,
      live_repo_count: tracked?.live ?? 0,
      member_count: members?.n ?? 0,
      // W20-17 (UX_TODO ADM-21): "ask an admin" now says who. Members only;
      // an admin has Settings → Members. Workspace-filtered (Law 5).
      admin_logins:
        request.role === 'admin'
          ? []
          : (
              await db
                .select({ login: core.users.login })
                .from(core.workspaceMembers)
                .innerJoin(core.users, eq(core.users.id, core.workspaceMembers.userId))
                .where(
                  and(
                    eq(core.workspaceMembers.workspaceId, request.workspace.id),
                    eq(core.workspaceMembers.role, 'admin'),
                  ),
                )
                .orderBy(core.users.login)
                .limit(5)
            ).map((r) => r.login),
      identity_id: ctx.identityId,
      default_view_id: defaultView?.id ?? null,
      // The persona's home, so the shell can land there after sign-in without
      // its own copy of PERSONA_HOME (DSH-03: it was applied only once, when
      // the picker was first answered).
      home: persona && PERSONAS.includes(persona) ? PERSONA_HOME[persona] : null,
      // W4-10 (UX_SPEC §6). NULL persona = never asked, which is what opens the
      // picker. Sent as part of the context the shell already fetches rather
      // than as its own request: a separate call would make the picker race the
      // first paint and flash the wrong home.
      persona,
      prefs: me?.prefs ?? {},
      demo: opts.demo ?? false,
      // W20-07 (UX_TODO INS-74): a federated sign-in no longer makes itself
      // admin, so a member on an install with NO admin needs to be told that
      // nobody can help them yet, and what the operator has to set.
      has_admin:
        request.role === 'admin' ||
        (await workspaceModule.workspaceHasAdmin(db, request.workspace.id)),
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
        repoOrg: core.repos.org,
        repoName: core.repos.name,
        state: facts.pullRequests.state,
        additions: facts.pullRequests.additions,
        deletions: facts.pullRequests.deletions,
        createdAt: facts.pullRequests.createdAt,
        mergedAt: facts.pullRequests.mergedAt,
        // W20-12 (UX_TODO DSH-42): what the stage chip is derived from.
        isDraft: facts.pullRequests.isDraft,
        firstReviewAt: facts.pullRequests.firstReviewAt,
        firstApprovalAt: facts.pullRequests.firstApprovalAt,
      })
      .from(facts.pullRequests)
      // Every My Focus list spans repositories, and PR numbers restart per
      // repository — "#5 feature 5" appearing twice is two different pull
      // requests, so the repo has to travel with the row. The join cannot drop
      // rows: repo_id is a NOT NULL foreign key into repos.
      .innerJoin(core.repos, eq(facts.pullRequests.repoId, core.repos.id))
      .where(
        and(
          // Law 5: the identity is the caller's, but the query still names the
          // workspace, like every other tenant-scoped read (W20-09).
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.authorIdentityId, ctx.identityId),
        ),
      )
      .orderBy(desc(facts.pullRequests.updatedAt));
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        repo: { id: p.repoId, org: p.repoOrg, name: p.repoName },
        state: p.state,
        size_bucket: prSizeBucket(p.additions + p.deletions),
        opened_at: p.createdAt.toISOString(),
        merged_at: p.mergedAt?.toISOString() ?? null,
        is_draft: p.isDraft,
        first_review_at: p.firstReviewAt?.toISOString() ?? null,
        first_approval_at: p.firstApprovalAt?.toISOString() ?? null,
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/review-queue — open PRs waiting on MY review (age-sorted).
  //
  // W20-16 (UX_TODO DSH-85). Requested reviewers are ingested since 0049, so
  // a PR whose request list is known is listed only when I am on it
  // (`requested: true`). GitHub and Gitea drop a reviewer from the list once
  // they review and add them back on a re-request, so the list itself is the
  // "since the last push" answer. A PR whose list is NOT captured yet (NULL:
  // ingested before 0049, filled on its next sync) falls back to the W20-09
  // heuristic — open, not a draft, not a bot, by someone else, not reviewed by
  // me — and comes back as `requested: null` so the screen can say so rather
  // than claim I was asked.
  app.get('/me/review-queue', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const me = ctx.identityId;
    const rows = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        repoId: facts.pullRequests.repoId,
        repoOrg: core.repos.org,
        repoName: core.repos.name,
        createdAt: facts.pullRequests.createdAt,
        author: core.identities.forgeLogin,
        requested: facts.pullRequests.requestedReviewerIdentityIds,
      })
      .from(facts.pullRequests)
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .innerJoin(core.repos, eq(facts.pullRequests.repoId, core.repos.id))
      .where(
        and(
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(core.repos.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.state, 'open'),
          ne(facts.pullRequests.authorIdentityId, me),
          // A draft is not asking for review yet; a bot PR is nobody's queue.
          eq(facts.pullRequests.isDraft, false),
          eq(facts.pullRequests.isBot, false),
          or(
            sql`${me} = any(${facts.pullRequests.requestedReviewerIdentityIds})`,
            and(
              sql`${facts.pullRequests.requestedReviewerIdentityIds} is null`,
              sql`not exists (select 1 from ${facts.prReviews} where ${facts.prReviews.pullRequestId} = ${facts.pullRequests.id} and ${facts.prReviews.reviewerIdentityId} = ${me})`,
            ),
          ),
        ),
      )
      .orderBy(facts.pullRequests.createdAt); // oldest first (age-sorted review load)
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        repo: { id: p.repoId, org: p.repoOrg, name: p.repoName },
        author: p.author,
        opened_at: p.createdAt.toISOString(),
        // true: the forge says I was asked. null: not captured for this PR yet.
        requested: p.requested === null ? null : true,
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/hotspots — the files I have changed most RECENTLY.
  //
  // W20-12 (UX_TODO DSH-88). This summed every line the user ever changed, all
  // time, under the title "Hotspots I own" — so long-deleted files and old
  // lockfiles ranked first and nothing on the card was a hotspot. It is now
  // bounded to the trailing 90 days (what "currently" can honestly mean from
  // commit facts) and the screen calls it what it is.
  app.get('/me/hotspots', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        repoId: facts.commitFiles.repoId,
        repoOrg: core.repos.org,
        repoName: core.repos.name,
        path: facts.commitFiles.path,
        myLines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .innerJoin(core.repos, eq(facts.commitFiles.repoId, core.repos.id))
      .where(
        and(
          eq(facts.commitFiles.workspaceId, ctx.workspaceId),
          eq(facts.commits.authorIdentityId, ctx.identityId),
          eq(facts.commits.isMerge, false),
          gte(facts.commits.authoredAt, new Date(Date.now() - MY_FILES_DAYS * 24 * 60 * 60 * 1000)),
        ),
      )
      // org/name are grouped rather than aggregated: they are functionally
      // dependent on repo_id, but Postgres only infers that through the repos
      // primary key, and naming them keeps the grouping obvious to a reader.
      .groupBy(facts.commitFiles.repoId, core.repos.org, core.repos.name, facts.commitFiles.path)
      .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`))
      .limit(50);
    return reply.send({
      items: rows.map((r) => ({
        repo_id: r.repoId,
        repo: { id: r.repoId, org: r.repoOrg, name: r.repoName },
        path: r.path,
        my_lines: r.myLines ?? 0,
        window_days: MY_FILES_DAYS,
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
      .where(
        and(
          // Law 5 (W20-12): this was the one My Focus read with no workspace
          // condition — an identity id alone is not a tenancy boundary.
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.authorIdentityId, ctx.identityId),
        ),
      );
    // `period: 'all_time'` (W20-12, UX_TODO DSH-40) so the tile can say which
    // period "PRs merged" covers instead of leaving the reader to guess.
    return reply.send({
      merged_prs: row?.mergedCount ?? 0,
      median_size: row?.medianSize ?? null,
      period: 'all_time',
    });
  });

  /**
   * GET /me/since — the since-last-visit strip (W6-09, R-A5).
   *
   * "Since when" is the user's own `prefs.lastVisitAt`, written by the client
   * on load. Deliberately per-user and deliberately NOT a 7-day window: a
   * strip that says "new this week" to someone who was here an hour ago is
   * noise, and to someone back from two weeks off it is a lie by omission.
   */
  app.get('/me/since', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx || request.workspace === undefined)
      return fail(request, reply, 401, 'No active session');

    const me = await readUser(request);
    const rawSince = (me?.prefs as Record<string, unknown> | undefined)?.lastVisitAt;
    const since = typeof rawSince === 'string' ? new Date(rawSince) : null;

    // No recorded visit = FIRST visit. Reported as such rather than defaulting
    // to a window: "3 new review requests" on someone's first ever load is a
    // number about nothing.
    if (since === null || Number.isNaN(since.getTime())) {
      return reply.send({
        since: null,
        first_visit: true,
        review_requests: 0,
        findings_on_my_prs: 0,
        prs_advanced: 0,
      });
    }

    const identityId = ctx.identityId;
    if (identityId === null) {
      return reply.send({
        since: since.toISOString(),
        first_visit: false,
        review_requests: 0,
        findings_on_my_prs: 0,
        prs_advanced: 0,
      });
    }

    const [reviewRequests] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(facts.prReviews)
      .where(
        and(
          eq(facts.prReviews.workspaceId, ctx.workspaceId),
          eq(facts.prReviews.reviewerIdentityId, identityId),
          gte(facts.prReviews.submittedAt, since),
        ),
      );

    const [advanced] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(facts.pullRequests)
      .where(
        and(
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.authorIdentityId, identityId),
          gte(facts.pullRequests.lastActivityAt, since),
        ),
      );

    const [findingsOnMine] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .innerJoin(facts.pullRequests, eq(facts.pullRequests.id, read.findings.pullRequestId))
      .where(
        and(
          eq(read.findings.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.authorIdentityId, identityId),
          gte(read.findings.firstSeenAt, since),
        ),
      );

    return reply.send({
      since: since.toISOString(),
      first_visit: false,
      // W20-12 (UX_TODO DSH-87): these are reviews the user SUBMITTED, not
      // requests made to them. Requested reviewers are ingested since 0049
      // (W20-16), but not WHEN each request was made, so "requests since your
      // last visit" still cannot be counted. Sent under the honest name;
      // `review_requests` stays as an alias for an older client and is no
      // longer read by this web app.
      reviews_given: reviewRequests?.n ?? 0,
      review_requests: reviewRequests?.n ?? 0,
      prs_advanced: advanced?.n ?? 0,
      findings_on_my_prs: findingsOnMine?.n ?? 0,
    });
  });

  /**
   * GET /me/inbox — what needs a human, since this user last looked (W20-10,
   * UX_TODO X-03).
   *
   * A leaked secret, a new KEV dependency or a critical finding waited until
   * someone happened to open the right tab: there was no inbox and no unread
   * badge, and email/Slack are out of scope (D7), so in-app is the only
   * channel. This answers "what is new and serious": open findings of high or
   * critical severity, any KEV or secrets finding, and scans that failed.
   *
   * "Since" is the user's own `prefs.inboxSeenAt`, moved by POST
   * /me/inbox/seen. Never looked = the last 7 days, said as such, so a first
   * visit is not a decade of backlog. Workspace-filtered (Law 5).
   */
  app.get('/me/inbox', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const me = await readUser(request);
    const raw = me?.prefs?.['inboxSeenAt'];
    const seen = typeof raw === 'string' ? new Date(raw) : null;
    const firstLook = seen === null || Number.isNaN(seen.getTime());
    const since = firstLook || seen === null ? new Date(Date.now() - INBOX_FIRST_LOOK_MS) : seen;

    const serious = or(
      gte(read.findings.severity, 4),
      eq(read.findings.dimension, 'secrets'),
      sql`${read.findings.yields} ->> 'kev' = 'true'`,
    );
    const findingWhere = and(
      eq(read.findings.workspaceId, workspaceId),
      eq(read.findings.status, 'open'),
      gt(read.findings.firstSeenAt, since),
      serious,
    );
    const [findingCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(findingWhere);
    const findings = await db
      .select({
        id: read.findings.id,
        title: read.findings.title,
        severity: read.findings.severity,
        dimension: read.findings.dimension,
        kev: sql<boolean>`coalesce(${read.findings.yields} ->> 'kev' = 'true', false)`,
        repoId: read.findings.repoId,
        org: core.repos.org,
        name: core.repos.name,
        at: read.findings.firstSeenAt,
      })
      .from(read.findings)
      .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
      .where(findingWhere)
      .orderBy(desc(read.findings.severity), desc(read.findings.firstSeenAt))
      .limit(INBOX_ITEMS);

    const scanWhere = and(
      eq(security.scanRuns.workspaceId, workspaceId),
      eq(security.scanRuns.status, 'failed'),
      gt(security.scanRuns.startedAt, since),
    );
    const [scanCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(security.scanRuns)
      .where(scanWhere);
    const scans = await db
      .select({
        id: security.scanRuns.id,
        scanner: security.scanRuns.scannerKey,
        error: security.scanRuns.error,
        repoId: security.scanRuns.repoId,
        org: core.repos.org,
        name: core.repos.name,
        at: security.scanRuns.startedAt,
      })
      .from(security.scanRuns)
      .innerJoin(
        core.repos,
        and(eq(core.repos.id, security.scanRuns.repoId), eq(core.repos.workspaceId, workspaceId)),
      )
      .where(scanWhere)
      .orderBy(desc(security.scanRuns.startedAt))
      .limit(INBOX_ITEMS);

    return reply.send({
      since: since.toISOString(),
      first_look: firstLook,
      unread: (findingCount?.n ?? 0) + (scanCount?.n ?? 0),
      findings_count: findingCount?.n ?? 0,
      failed_scans_count: scanCount?.n ?? 0,
      findings: findings.map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        dimension: f.dimension,
        kev: f.kev,
        repo_id: f.repoId,
        repo: `${f.org}/${f.name}`,
        at: f.at.toISOString(),
      })),
      failed_scans: scans.map((r) => ({
        id: r.id,
        scanner: r.scanner,
        // The first line only: a scanner's stderr can run to pages.
        error: r.error === null ? null : (r.error.split('\n')[0] ?? '').slice(0, 200),
        repo_id: r.repoId,
        repo: `${r.org}/${r.name}`,
        at: r.at.toISOString(),
      })),
    });
  });

  /** POST /me/inbox/seen — "I have looked": the badge counts from now. */
  app.post('/me/inbox/seen', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId === undefined) return fail(request, reply, 401, 'No active session');
    const at = new Date().toISOString();
    // jsonb merge in SQL, so a concurrent PATCH /me/prefs cannot be lost.
    await db
      .update(core.users)
      .set({ prefs: sql`${core.users.prefs} || ${JSON.stringify({ inboxSeenAt: at })}::jsonb` })
      .where(eq(core.users.id, userId));
    return reply.send({ seen_at: at });
  });
}
