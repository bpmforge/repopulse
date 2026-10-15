import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// Retention for stored code context (W18-32).
//
// A finding keeps a few lines of the scanned file so the app can show the code
// without a clone. Those lines are customer code, so they are not kept forever:
// once a finding is closed (resolved, dismissed, won't fix) the lines go after
// FINDING_CONTEXT_RETENTION_DAYS. Open and confirmed findings keep theirs,
// refreshed on every sighting. The finding row, its history and its evidence
// quote stay; only the copied lines are cleared.
//
// Run from persistFindings rather than a scheduled job, because no scheduler
// owns retention sweeps yet (ingest/retention/sweeps.ts is not wired to one):
// every scan of a repo tidies that repo's closed findings, so the work is
// bounded and needs no new moving part.

/** Days a closed finding keeps its stored lines. Override: FINDING_CONTEXT_RETENTION_DAYS. */
export const DEFAULT_FINDING_CONTEXT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function findingContextRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FINDING_CONTEXT_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_FINDING_CONTEXT_RETENTION_DAYS;
  const n = Number(raw);
  // 0 is allowed and means "clear on close"; anything not a whole number >= 0
  // falls back to the default rather than silently keeping code forever.
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FINDING_CONTEXT_RETENTION_DAYS;
}

/** Clears stored lines on findings closed longer ago than the retention window. */
export async function pruneClosedFindingContext(
  db: Database,
  opts: { workspaceId: number; repoId: number; nowMs?: number; days?: number },
): Promise<void> {
  const days = opts.days ?? findingContextRetentionDays();
  const cutoff = new Date((opts.nowMs ?? Date.now()) - days * DAY_MS);
  await db
    .update(read.findings)
    .set({ contextLines: null, contextStartLine: null })
    .where(
      and(
        eq(read.findings.workspaceId, opts.workspaceId),
        eq(read.findings.repoId, opts.repoId),
        isNotNull(read.findings.contextLines),
        inArray(read.findings.status, ['resolved', 'dismissed', 'wont_fix']),
        lt(read.findings.statusChangedAt, cutoff),
      ),
    );
}
