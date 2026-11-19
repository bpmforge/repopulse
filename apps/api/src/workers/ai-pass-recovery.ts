import { and, asc, eq, inArray } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import type { AiPassJobData } from './ai-pass-processor.js';

// AI passes a stopped worker left behind (W27-22).
//
// A pass marks its row `running` before the first model call, and a model
// call can take many minutes. A worker that is killed in between (a restart,
// an out-of-memory kill, the container host going down) leaves two things
// nobody else repairs:
//
//   - the row stays `running` for ever. The queue does hand the job to the
//     next worker, but the processor's compare-and-set on `pending` refuses
//     it ("already_started"), so the row never moves and the page shows a
//     pass that is not happening. It also blocks the repository's judge run,
//     which waits for the first look.
//   - a `pending` row whose queue entry died with the queue's memory is never
//     picked up at all.
//
// Measured on 2026-11-18: the container host went down mid first look; after
// the restart the first look read `running` and the judge `pending` until a
// person cancelled them.
//
// At boot no pass can be running in THIS process, so every `running` row is
// closed as interrupted, in words, and every `pending` row gets a queue entry
// again. A second entry for a row that still has one is harmless: whichever
// runs second fails the same compare-and-set.
//
// ONE WORKER. With several worker replicas a booting replica cannot tell its
// own orphans from a sibling's live pass, so the sweep is switched off there
// (AI_PASS_BOOT_RECOVERY=off) and the judge's own stale cutoff is what remains.

export const INTERRUPTED_CODE = 'interrupted';
export const INTERRUPTED_REASON =
  'The worker stopped while this pass was running, so it was closed. Start it again.';

/** More than this many pending rows at boot is a backlog, not a crash: the first ones go. */
const MAX_REQUEUED = 200;

export interface AiPassRecoveryDeps {
  db: Database;
  /** Adds a queue entry for a pending run. */
  enqueue: (data: AiPassJobData, bootId: number) => Promise<void>;
  now?: () => Date;
  /** Tests only: sweep just these workspaces (the suite shares one database). */
  onlyWorkspaces?: readonly number[];
}

export interface AiPassRecoveryResult {
  /** Runs that read `running` and were closed as interrupted. */
  interrupted: number[];
  /** Pending runs given a queue entry again. */
  requeued: number[];
}

export function aiPassBootRecoveryOn(env: Record<string, string | undefined>): boolean {
  return (env['AI_PASS_BOOT_RECOVERY'] ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * Closes orphaned `running` passes and requeues `pending` ones. Call once, at
 * worker boot, before any pass can start.
 *
 * Workspace by workspace (Law 5): the sweep is system work, but each write and
 * each queue entry stays inside the workspace whose rows it read.
 */
export async function recoverAiPassRuns(deps: AiPassRecoveryDeps): Promise<AiPassRecoveryResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const bootId = now.getTime();
  const result: AiPassRecoveryResult = { interrupted: [], requeued: [] };

  const open = await db
    .selectDistinct({ workspaceId: read.aiPassRuns.workspaceId })
    .from(read.aiPassRuns)
    .where(inArray(read.aiPassRuns.status, ['pending', 'running']));

  for (const { workspaceId } of open) {
    if (deps.onlyWorkspaces && !deps.onlyWorkspaces.includes(workspaceId)) continue;
    const closed = await db
      .update(read.aiPassRuns)
      .set({
        status: 'failed',
        reasonCode: INTERRUPTED_CODE,
        reason: INTERRUPTED_REASON,
        finishedAt: now,
      })
      .where(
        and(eq(read.aiPassRuns.workspaceId, workspaceId), eq(read.aiPassRuns.status, 'running')),
      )
      .returning({ id: read.aiPassRuns.id });
    result.interrupted.push(...closed.map((r) => r.id));

    const pending = await db
      .select({ id: read.aiPassRuns.id })
      .from(read.aiPassRuns)
      .where(
        and(eq(read.aiPassRuns.workspaceId, workspaceId), eq(read.aiPassRuns.status, 'pending')),
      )
      .orderBy(asc(read.aiPassRuns.id))
      .limit(MAX_REQUEUED);
    for (const run of pending) {
      if (result.requeued.length >= MAX_REQUEUED) break;
      await deps.enqueue({ workspaceId, runId: run.id }, bootId);
      result.requeued.push(run.id);
    }
  }
  result.interrupted.sort((a, b) => a - b);
  return result;
}
