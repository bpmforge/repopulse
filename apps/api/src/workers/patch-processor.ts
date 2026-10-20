import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { read, type Database } from '@repopulse/shared';
import type { AnalysisGateway } from '@repopulse/analysis';
import type { ForgeProvider } from '@repopulse/forge';
import { runPatchDraft, type PatchDraftResult } from '@repopulse/security';
import { isAiPaused } from '../lib/ai-pause.js';

// patches.draft processor (W18-19, D16 "Verified + CI pull").
//
// The API inserts a `pending` row and enqueues its id; this resolves the
// workspace's own model and the repository's forge, and hands both to the
// drafting job, which writes the verdict onto the row. Everything that can go
// wrong is recorded THERE — on the row a person is looking at — rather than in
// a failed job only the dead-letter page shows.

export interface PatchJobData {
  workspaceId: number;
  patchId: number;
  /** The request that asked for it, for the dead-letter ledger (W16-18). */
  requestId?: string;
}

export interface PatchProcessorDeps {
  db: Database;
  /** This workspace's gateway (W16-19); null when it has no model. */
  gatewayFor: (workspaceId: number) => Promise<AnalysisGateway | null>;
  /** The repository's forge; null when it has no active connection. */
  forgeFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
  /** Injectable for tests. */
  run?: typeof runPatchDraft;
}

export function patchProcessor(deps: PatchProcessorDeps) {
  const run = deps.run ?? runPatchDraft;
  return async function process(job: Job<PatchJobData>): Promise<PatchDraftResult> {
    const { workspaceId, patchId } = job.data;
    const [row] = await deps.db
      .select({ repoId: read.verifiedPatches.repoId, status: read.verifiedPatches.status })
      .from(read.verifiedPatches)
      .where(
        and(
          eq(read.verifiedPatches.id, patchId),
          eq(read.verifiedPatches.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) return { status: 'skipped', code: 'not_found', reason: 'No such patch request.' };
    if (row.status !== 'pending') {
      return { status: 'skipped', code: 'already_decided', reason: `Already ${row.status}.` };
    }

    // W20-18 (UX_TODO AI-77): AI switched off after this was queued. No model
    // is called; the row says why, in words a member may read.
    if (await isAiPaused(deps.db, workspaceId)) {
      const reason =
        'AI analysis was switched off for this workspace before the fix was drafted, so no model was asked.';
      await deps.db
        .update(read.verifiedPatches)
        .set({ status: 'failed', reasonCode: 'ai_paused', reason, finishedAt: new Date() })
        .where(
          and(
            eq(read.verifiedPatches.id, patchId),
            eq(read.verifiedPatches.workspaceId, workspaceId),
          ),
        );
      return { status: 'failed', code: 'ai_paused', reason };
    }

    let forge: Awaited<ReturnType<PatchProcessorDeps['forgeFor']>>;
    let gateway: AnalysisGateway | null;
    try {
      gateway = await deps.gatewayFor(workspaceId);
      forge = await deps.forgeFor(workspaceId, row.repoId);
    } catch (err) {
      // A connection whose credential will not decrypt, a provider row that
      // will not resolve: the row says so, in the words the error used.
      const reason = err instanceof Error ? err.message : String(err);
      await deps.db
        .update(read.verifiedPatches)
        .set({
          status: 'failed',
          reasonCode: 'error',
          reason: reason.slice(0, 2000),
          finishedAt: new Date(),
        })
        .where(eq(read.verifiedPatches.id, patchId));
      return { status: 'failed', code: 'error', reason };
    }

    return run({ db: deps.db, workspaceId, patchId, gateway, forge });
  };
}
