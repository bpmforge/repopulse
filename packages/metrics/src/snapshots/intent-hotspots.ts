import { and, asc, eq, inArray } from 'drizzle-orm';
import { plans, read, type Database } from '@repopulse/shared';
import { computeHotspots, type HotspotDecomposition } from '../metrics/hotspots.js';
import { readChurnTouches } from './readers.js';

// Hotspot score history for files that carry an intent (W20-24, UX_TODO
// DSH-37). M2's per-file list on each snapshot keeps only a repository's top
// files, so a file that cooled off dropped out of it and "has the hotspot
// improved since the intent was declared?" could not be answered. This writes
// one row per intent file per run into file_hotspot_scores: once when the
// intent is saved (the baseline) and from every snapshot run after.

/** The window the score is computed over: the file page's and Hotspots tab's. */
export const INTENT_HOTSPOT_WINDOW = { key: '30d', days: 30 } as const;

export interface RecordIntentHotspotParams {
  workspaceId: number;
  repoId: number;
  asOf: Date;
  botGlobs?: readonly string[];
  /** Only these paths. Absent = every path with an intent in this repository. */
  paths?: readonly string[];
  /** Already computed over INTENT_HOTSPOT_WINDOW (the snapshot run has them). */
  hotspots?: readonly Pick<HotspotDecomposition, 'path' | 'score'>[];
}

/**
 * Write the current hotspot score of each intent file. Returns the rows
 * written.
 *
 * A file with no eligible touch in the window scores 0: that is the formula's
 * answer (no churn, nothing hot), not a missing measurement. A repository
 * with no touches at all in the window writes nothing — with no commits read
 * there is nothing to say either way.
 */
export async function recordIntentHotspotScores(
  db: Database,
  params: RecordIntentHotspotParams,
): Promise<number> {
  const paths =
    params.paths ??
    (
      await db
        .select({ path: plans.fileIntents.path })
        .from(plans.fileIntents)
        .where(
          and(
            eq(plans.fileIntents.workspaceId, params.workspaceId),
            eq(plans.fileIntents.repoId, params.repoId),
          ),
        )
    ).map((r) => r.path);
  if (paths.length === 0) return 0;

  let hotspots = params.hotspots;
  if (!hotspots) {
    const since = new Date(params.asOf.getTime() - INTENT_HOTSPOT_WINDOW.days * 86_400_000);
    const touches = await readChurnTouches(db, params.repoId, since, {
      workspaceId: params.workspaceId,
    });
    if (touches.length === 0) return 0;
    hotspots = computeHotspots(touches, params.asOf, params.botGlobs);
  } else if (hotspots.length === 0) {
    return 0;
  }

  const byPath = new Map(hotspots.map((h) => [h.path, h.score]));
  const rows = [...new Set(paths)].map((path) => ({
    workspaceId: params.workspaceId,
    repoId: params.repoId,
    path,
    window: INTENT_HOTSPOT_WINDOW.key,
    score: String(Math.round((byPath.get(path) ?? 0) * 1e6) / 1e6),
    computedAt: params.asOf,
  }));
  await db.insert(read.fileHotspotScores).values(rows);
  return rows.length;
}

export interface IntentHotspotPoint {
  repoId: number;
  path: string;
  at: Date;
  score: number;
}

/**
 * Stored points for these files, oldest first, workspace-filtered. Keyed by
 * repository and path so a common filename in two repositories never shares a
 * history.
 */
export async function readIntentHotspotHistory(
  db: Database,
  workspaceId: number,
  files: readonly { repoId: number; path: string }[],
): Promise<Map<string, IntentHotspotPoint[]>> {
  const out = new Map<string, IntentHotspotPoint[]>();
  if (files.length === 0) return out;
  const repoIds = [...new Set(files.map((f) => f.repoId))];
  const paths = [...new Set(files.map((f) => f.path))];
  const rows = await db
    .select({
      repoId: read.fileHotspotScores.repoId,
      path: read.fileHotspotScores.path,
      score: read.fileHotspotScores.score,
      at: read.fileHotspotScores.computedAt,
    })
    .from(read.fileHotspotScores)
    .where(
      and(
        eq(read.fileHotspotScores.workspaceId, workspaceId),
        eq(read.fileHotspotScores.window, INTENT_HOTSPOT_WINDOW.key),
        inArray(read.fileHotspotScores.repoId, repoIds),
        inArray(read.fileHotspotScores.path, paths),
      ),
    )
    .orderBy(asc(read.fileHotspotScores.computedAt), asc(read.fileHotspotScores.id));
  const wanted = new Set(files.map((f) => intentFileKey(f.repoId, f.path)));
  for (const r of rows) {
    const key = intentFileKey(r.repoId, r.path);
    if (!wanted.has(key)) continue;
    const list = out.get(key) ?? [];
    list.push({ repoId: r.repoId, path: r.path, at: r.at, score: Number(r.score) });
    out.set(key, list);
  }
  return out;
}

export function intentFileKey(repoId: number, path: string): string {
  return `${repoId}\u0000${path}`;
}
