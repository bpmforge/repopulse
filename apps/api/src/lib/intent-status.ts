import { and, eq, inArray } from 'drizzle-orm';
import { plans, type Database } from '@repopulse/shared';
import { intentFileKey, readIntentHotspotHistory } from '@repopulse/metrics';
import { intentWarnings, type Intent, type IntentWarning } from '@repopulse/insights';

// Whether an intent's hotspot has improved since it was declared (W20-24,
// UX_TODO DSH-37). Reads only our database: the intent rows and the per-file
// score history the snapshot run and PUT /intents write. The warning rules are
// insights' intentWarnings, which until now had no caller.

export interface IntentHotspotStatus {
  /** First point at or after the declaration, and the newest one. */
  first: { at: string; score: number } | null;
  latest: { at: string; score: number } | null;
  points: number;
  /**
   * true: lower than when declared. false: the same or higher. null: fewer
   * than two points since the declaration, so there is nothing to compare.
   */
  improved: boolean | null;
  warnings: IntentWarning[];
}

export interface IntentRowWithStatus {
  id: number;
  repoId: number;
  path: string;
  intent: string;
  note: string | null;
  warnAfterMonths: number;
  createdAt: Date;
  status: IntentHotspotStatus;
}

export function statusOf(
  intent: {
    repoId: number;
    path: string;
    intent: string;
    createdAt: Date;
    warnAfterMonths: number;
  },
  history: readonly { at: Date; score: number }[],
  now: Date,
): IntentHotspotStatus {
  const since = history
    .filter((p) => p.at.getTime() >= intent.createdAt.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = since[0];
  const last = since[since.length - 1];
  const known = intent.intent === 'refactor' || intent.intent === 'supervise';
  return {
    first: first ? { at: first.at.toISOString(), score: first.score } : null,
    latest: last ? { at: last.at.toISOString(), score: last.score } : null,
    points: since.length,
    improved: since.length < 2 || !first || !last ? null : last.score < first.score,
    warnings: known
      ? intentWarnings(
          {
            repoId: intent.repoId,
            path: intent.path,
            intent: intent.intent as Intent,
            createdAt: intent.createdAt,
            warnAfterMonths: intent.warnAfterMonths,
          },
          since,
          now,
        )
      : [],
  };
}

/** Every intent in scope with its hotspot status. Workspace-filtered (Law 5). */
export async function intentsWithStatus(
  db: Database,
  workspaceId: number,
  repoIds: readonly number[] = [],
  now: Date = new Date(),
): Promise<IntentRowWithStatus[]> {
  const rows = await db
    .select()
    .from(plans.fileIntents)
    .where(
      and(
        eq(plans.fileIntents.workspaceId, workspaceId),
        repoIds.length > 0 ? inArray(plans.fileIntents.repoId, [...repoIds]) : undefined,
      ),
    );
  const history = await readIntentHotspotHistory(db, workspaceId, rows);
  return rows.map((r) => ({
    id: r.id,
    repoId: r.repoId,
    path: r.path,
    intent: r.intent,
    note: r.note,
    warnAfterMonths: r.warnAfterMonths,
    createdAt: r.createdAt,
    status: statusOf(r, history.get(intentFileKey(r.repoId, r.path)) ?? [], now),
  }));
}
