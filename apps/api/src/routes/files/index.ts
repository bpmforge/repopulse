import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, type Database } from '@repopulse/shared';
import {
  attributeRework,
  computeHotspots,
  readChurnTouches,
  readMetricTrend,
  scopeTouchesToFile,
} from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';
import { fileForgeUrl, readRepoForge } from '../../lib/forge-links.js';

// File detail (FR-API-5, API_DESIGN §2): churn series + owners + hotspot
// history for one path. Path can contain slashes → wildcard route param.

export interface FilesRoutesOptions {
  db: Database;
}

const WEEKS = 52;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** UTC week start (Monday) as an ISO date — the bucket key for the 52w bars. */
function weekKey(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // getUTCDay(): 0 = Sunday. Shift so Monday starts the week.
  const dayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * 52 contiguous weekly buckets ending this week, oldest first.
 *
 * Empty weeks are emitted as zeros rather than omitted. A series containing
 * only the weeks that had commits compresses quiet periods out of the chart, so
 * a file touched twice a year renders as a dense bar pair and reads as busy.
 */
function weeklyBuckets(
  weeks: ReadonlyMap<string, { gross: number; net: number; rework: number }>,
): { week: string; gross: number; net: number; rework: number }[] {
  const out: { week: string; gross: number; net: number; rework: number }[] = [];
  const thisWeek = new Date(`${weekKey(new Date())}T00:00:00.000Z`).getTime();
  for (let i = WEEKS - 1; i >= 0; i--) {
    const key = new Date(thisWeek - i * WEEK_MS).toISOString().slice(0, 10);
    const bucket = weeks.get(key) ?? { gross: 0, net: 0, rework: 0 };
    out.push({ week: key, ...bucket });
  }
  return out;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

/** The window the header's current hotspot score is computed over (the repo tab's default). */
const HOTSPOT_WINDOW_DAYS = 30;

export default async function filesRoutes(
  app: FastifyInstance,
  opts: FilesRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get<{ Params: { id: string; '*': string } }>('/repos/:id/files/*', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    // Workspace-filtered (Law 5) and, since W20-12, also the facts the forge
    // link is built from — one read instead of an ownership check plus a second.
    const forge = Number.isInteger(repoId) ? await readRepoForge(db, workspaceId, repoId) : null;
    if (!forge) return fail(request, reply, 404, 'Not Found');
    const path = request.params['*'];

    // Per-commit churn series for the file (non-merge commits).
    const series = await db
      .select({
        sha: facts.commits.sha,
        authoredAt: facts.commits.authoredAt,
        additions: facts.commitFiles.additions,
        deletions: facts.commitFiles.deletions,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .where(
        and(
          eq(facts.commitFiles.repoId, repoId),
          eq(facts.commitFiles.path, path),
          eq(facts.commits.isMerge, false),
        ),
      )
      .orderBy(asc(facts.commits.authoredAt));

    // Owners by lines changed.
    const owners = await db
      .select({
        login: core.identities.forgeLogin,
        lines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
      .where(
        and(
          eq(facts.commitFiles.repoId, repoId),
          eq(facts.commitFiles.path, path),
          eq(facts.commits.isMerge, false),
        ),
      )
      .groupBy(core.identities.forgeLogin)
      .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`));

    // W20-12 (UX_TODO DSH-94): NO COMMITS IS AN ANSWER, NOT A 404. A PR's
    // "Files changed" links every path it touches, and a file the PR adds has
    // no default-branch commit until it merges (backfill reads the default
    // branch only). The 404 turned the file page into four error cards whose
    // Retry could never work. The empty answer carries the reason; the PRs
    // query below still runs, because pr_files does know this path.
    const noCommits = series.length === 0;
    const totalLines = owners.reduce((s, o) => s + (o.lines ?? 0), 0);

    // --- W4-17: weekly gross/net/rework, rename chain, hotspot history, PRs ---

    // Repo-wide touches, because the rename chain and the rework lookback both
    // need touches that are NOT on this path: a file's history before a rename
    // lives under its old name.
    const touches = await readChurnTouches(db, repoId, new Date(Date.now() - WEEKS * WEEK_MS));
    const scoped = scopeTouchesToFile(touches, path);
    // Rework is attributed over the WHOLE ordered sequence and bucketed
    // afterwards. Bucketing first and computing per bucket would zero the
    // rework of every touch whose predecessor fell in the previous week —
    // wrong at exactly the cadence this chart displays (METRICS.md §1 M1).
    const attributed = attributeRework(scoped.filter((t) => t.parentShaCount === 1));

    const weeks = new Map<string, { gross: number; net: number; rework: number }>();
    for (const { touch, rework } of attributed) {
      const key = weekKey(new Date(touch.touchedAt));
      const bucket = weeks.get(key) ?? { gross: 0, net: 0, rework: 0 };
      bucket.gross += touch.additions + touch.deletions;
      bucket.net += touch.additions - touch.deletions;
      bucket.rework += rework;
      weeks.set(key, bucket);
    }

    // The rename chain, oldest first. Built from previousPath on the touches
    // themselves (FORGE_PROVIDER §1) rather than guessed from similar names.
    const renameChain: { path: string; renamed_at: string }[] = [];
    for (const t of [...scoped].sort(
      (a, b) => new Date(a.touchedAt).getTime() - new Date(b.touchedAt).getTime(),
    )) {
      if (t.previousPath && t.previousPath !== t.path) {
        renameChain.push({ path: t.previousPath, renamed_at: t.touchedAt });
      }
    }

    // Hotspot history: M2's snapshot series, so the sparkline plots the same
    // numbers the repo screen ranks by rather than a second computation.
    const hotspotHistory = await readMetricTrend(db, {
      workspaceId,
      repoId,
      metricKey: 'M2',
      window: '30d',
      limit: 26,
    });

    // PRs that touched this file, read from pr_files — the per-PR file list
    // the enrichment lane writes. Matched on the CURRENT path only: pr_files
    // records the path as of that PR, so a PR that touched the file under its
    // old name is not listed here. That is a known limit of this join rather
    // than an empty list meaning "no PRs touched it", and the rename chain
    // beside it is what tells a reader to go looking.
    const prRows = await db
      .selectDistinct({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        state: facts.pullRequests.state,
        mergedAt: facts.pullRequests.mergedAt,
        author: core.identities.forgeLogin,
      })
      .from(facts.prFiles)
      .innerJoin(facts.pullRequests, eq(facts.prFiles.pullRequestId, facts.pullRequests.id))
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .where(and(eq(facts.prFiles.repoId, repoId), eq(facts.prFiles.path, path)))
      .orderBy(desc(facts.pullRequests.number))
      .limit(25);

    const lastTouch = series[series.length - 1];

    // W20-12 (UX_TODO DSH-35): the file's CURRENT hotspot score, for the
    // header. Computed exactly as the repo Hotspots tab ranks it (M2 over the
    // trailing 30 days, normalised within this repository), from the touches
    // already read above — so the two screens cannot disagree about a file.
    const hotspotSince = Date.now() - HOTSPOT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const current = computeHotspots(
      touches.filter((t) => new Date(t.touchedAt).getTime() >= hotspotSince),
      new Date(),
    ).find((h) => h.path === path);

    return reply.send({
      path,
      no_commits: noCommits,
      // W20-12 (UX_TODO DSH-68): the file on the forge's default branch. Null
      // when the forge's web root cannot be known (a Gitea with no base URL).
      forge_url: fileForgeUrl(forge, path),
      default_branch: forge.defaultBranch,
      hotspot: current
        ? {
            score: current.score,
            gross: current.gross,
            days_since: current.daysSince,
            window_days: HOTSPOT_WINDOW_DAYS,
          }
        : null,
      churn_series: series.map((c) => ({
        sha: c.sha,
        authored_at: c.authoredAt.toISOString(),
        additions: c.additions,
        deletions: c.deletions,
      })),
      // 52 weekly buckets, oldest first, INCLUDING empty ones: a chart drawn
      // from only the weeks that have data compresses quiet periods away and
      // makes a file look busier than it is.
      weekly_churn: weeklyBuckets(weeks),
      owners: owners.map((o) => ({
        login: o.login,
        lines_changed: o.lines ?? 0,
        share: totalLines > 0 ? (o.lines ?? 0) / totalLines : 0,
      })),
      hotspot_history: (noCommits ? [] : hotspotHistory)
        .map((h) => ({ computed_at: h.computedAt, score: Number(h.value) }))
        .reverse(),
      prs: prRows.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        author: p.author,
        merged_at: p.mergedAt?.toISOString() ?? null,
        links: { self: `/api/v1/repos/${repoId}/prs/${p.number}` },
      })),
      // UX_SPEC §4.d's deleted/renamed banner. `last_seen_at` is the newest
      // touch we hold; the API does not claim the file is deleted, because the
      // warehouse cannot tell "deleted" from "not touched lately" — the screen
      // says "last seen", which is exactly what we know.
      last_seen_at: lastTouch ? lastTouch.authoredAt.toISOString() : null,
      previous_paths: renameChain,
      links: { repo: `/api/v1/repos/${repoId}` },
    });
  });
}
