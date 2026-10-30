import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import {
  HostUnavailableError,
  TierNotPermittedError,
  type AnalysisGateway,
  type Dimension,
} from '@repopulse/analysis';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../snapshot/fetch.js';
import { readSnapshotSources, type SourceFile } from '../snapshot/sources.js';
import { MAX_DIFF_BYTES, PatchRejectedError, validateAndApply } from './diff.js';
import { buildPatchPrompt, extractNoSafeFix, PATCH_PROMPT_VERSION } from './prompt.js';
import { productionRunners } from './runners.js';
import { resolvePatchTarget } from './target.js';
import { safeJoin, verifyPatch, type FileRuleRunner } from './verify.js';

// The patch-drafting job (W18-19, D16 "Verified + CI pull").
//
//   1. the configured model drafts a unified diff for one finding;
//   2. the diff's shape is checked and it is applied to the file AT THE SCAN'S
//      COMMIT (diff.ts);
//   3. a patch that removes error handling or adds a force-unwrap is rejected
//      (guard.ts); otherwise the file is re-scanned before and after inside the
//      sandbox flow, and the patch is verified only if the finding clears and
//      nothing new fires (verify.ts);
//   4. the row is updated with the verdict.
//
// READ-ONLY TOWARDS THE FORGE (D9a). The only forge calls on this path are the
// two reads below — the archive at the scanned commit, or the one file when the
// forge cannot supply an archive — both on the budgeted `scan` lane. No branch,
// no commit, no pull request, no comment: the diff is handed to a person, who
// applies it with their own tools. patches.no-forge-write.test.ts holds this.

export interface PatchDraftDeps {
  db: Database;
  workspaceId: number;
  patchId: number;
  /** This workspace's gateway; null when it has no model configured. */
  gateway: AnalysisGateway | null;
  /** The repository's forge, or null when it has no active connection. */
  forge: { provider: ForgeProvider; repoFullName: string } | null;
  /** Injected in tests; production re-runs the shipped packs in the sandbox. */
  runners?: readonly FileRuleRunner[];
  /** Scratch root for the before/after files; defaults to the snapshot root. */
  root?: string;
  /**
   * Who asked, on the egress audit. Defaults to the person on the row, or
   * `patch_draft`; W22-09's after-judge drafting passes `ai-fix`.
   */
  initiator?: string;
}

export interface PatchDraftResult {
  status: 'verified' | 'rejected' | 'failed' | 'skipped';
  code: string;
  reason: string;
}

/** The gateway's dimension for a finding dimension — which checklist family is asking. */
function gatewayDimension(dimension: string): Dimension {
  if (dimension === 'sast' || dimension === 'security' || dimension === 'secrets')
    return 'security';
  if (dimension === 'performance') return 'performance';
  return 'code_health';
}

interface SnapshotView {
  source: string;
  tree?: readonly SourceFile[];
  treeComplete: boolean;
}

/**
 * The file at the scanned commit, and the tree around it when there is one.
 *
 * The archive when the forge can supply it — the whole-tree rules (phantom
 * imports, unused exports) need the rest of the repository to judge the
 * patched file, and a model inventing an import is the commonest way a fix
 * goes wrong. Otherwise the one file, and those rules report that they could
 * not run rather than passing.
 */
async function withSnapshotView<T>(
  forge: { provider: ForgeProvider; repoFullName: string },
  args: { repoId: number; commitSha: string; file: string },
  fn: (view: SnapshotView) => Promise<T>,
): Promise<T | null> {
  if (forge.provider.capabilities.supportsTarball) {
    return snapshotForScan(
      { provider: forge.provider, repo: forge.repoFullName, commitSha: args.commitSha },
      async (snapshot) => {
        let source: string;
        try {
          source = await readFile(safeJoin(snapshot.dir, args.file), 'utf8');
        } catch {
          return null;
        }
        const sources = readSnapshotSources(snapshot.dir);
        return fn({
          source,
          tree: sources.files,
          treeComplete: !sources.truncated && sources.skipped === 0,
        });
      },
    );
  }

  const content = await forge.provider.getFileContent(
    { lane: 'scan', repoId: String(args.repoId) },
    forge.repoFullName,
    args.file,
    args.commitSha,
  );
  if (content.content === null) return null;
  return fn({ source: content.content, treeComplete: false });
}

export async function runPatchDraft(deps: PatchDraftDeps): Promise<PatchDraftResult> {
  const { db } = deps;
  const [row] = await db
    .select()
    .from(read.verifiedPatches)
    .where(
      and(
        eq(read.verifiedPatches.id, deps.patchId),
        eq(read.verifiedPatches.workspaceId, deps.workspaceId),
      ),
    )
    .limit(1);
  if (!row) return { status: 'skipped', code: 'not_found', reason: 'No such patch request.' };
  // IDEMPOTENT: a decided row is never re-drafted by a duplicate job. Only the
  // API resets a `failed` row to `pending`, and only on a person's request.
  if (row.status !== 'pending') {
    return { status: 'skipped', code: 'already_decided', reason: `Already ${row.status}.` };
  }

  const finish = async (
    result: Omit<PatchDraftResult, 'status'> & { status: 'verified' | 'rejected' | 'failed' },
    extra: Partial<typeof read.verifiedPatches.$inferInsert> = {},
  ): Promise<PatchDraftResult> => {
    await db
      .update(read.verifiedPatches)
      .set({
        status: result.status,
        reasonCode: result.code,
        reason: result.reason.slice(0, 2000),
        finishedAt: new Date(),
        ...extra,
      })
      .where(eq(read.verifiedPatches.id, row.id));
    return result;
  };

  const target = await resolvePatchTarget(db, deps.workspaceId, row.findingId);
  if (!target.ok) return finish({ status: 'failed', code: target.code, reason: target.reason });

  if (!deps.gateway) {
    return finish({
      status: 'failed',
      code: 'no_gateway',
      reason: 'No model is configured for this workspace — add one in Settings → Models.',
    });
  }
  if (!deps.forge) {
    return finish({
      status: 'failed',
      code: 'no_connection',
      reason:
        'This repository has no active forge connection, so the scanned file could not be read.',
    });
  }
  const gateway = deps.gateway;
  const runners = deps.runners ?? productionRunners();

  try {
    const outcome = await withSnapshotView(
      deps.forge,
      { repoId: row.repoId, commitSha: row.commitSha, file: target.file },
      async (view) => {
        const prompt = buildPatchPrompt(target, view.source);
        const completion = await gateway.complete(prompt, {
          tier: row.tier === 3 ? 'T3' : 'T2',
          maxTokens: 45_000,
          temperature: 0,
          expectJson: true,
          meta: {
            repoId: String(row.repoId),
            prNumber: 0,
            dimension: gatewayDimension(target.dimension),
            checklistVersion: PATCH_PROMPT_VERSION,
            // W22-09: routed by the `patch` role, the route the drawer names
            // ("Drafted by ...") and the after-judge drafting checks for egress.
            // It used to route by the finding's dimension, so a patch chain an
            // admin set was shown but not used.
            role: 'patch',
            initiator:
              deps.initiator ??
              (row.requestedBy !== null ? `user:${row.requestedBy}` : 'patch_draft'),
          },
        });
        const drafted = {
          modelId: completion.model,
          promptVersion: PATCH_PROMPT_VERSION,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
        };

        // The prompt's way out (2026-10-30): when the only way to clear the
        // rule would remove or weaken error handling, the model says so
        // instead of drafting. That is a verdict like a rejected draft (the
        // after-judge loop does not ask again); there is no diff to keep.
        const noSafeFix = extractNoSafeFix(completion.text);
        if (noSafeFix !== null) {
          return finish(
            {
              status: 'rejected',
              code: 'no_safe_fix',
              reason: `The model found no fix that keeps the error handling: ${noSafeFix}`,
            },
            drafted,
          );
        }

        let applied;
        try {
          applied = validateAndApply({
            modelText: completion.text,
            file: target.file,
            source: view.source,
          });
        } catch (err) {
          if (!(err instanceof PatchRejectedError)) throw err;
          // Kept for the admin reading why — capped, and never served to a
          // developer (the API strips it from a rejected row).
          return finish(
            { status: 'rejected', code: `diff_${err.code}`, reason: err.message },
            { ...drafted, diff: completion.text.slice(0, MAX_DIFF_BYTES) },
          );
        }

        const verdict = await verifyPatch({
          target: {
            dedupKey: row.targetDedupKey,
            scannerKey: target.scannerKey,
            ruleId: target.ruleId,
            file: target.file,
          },
          before: view.source,
          after: applied.after,
          runners,
          ...(view.tree ? { tree: view.tree } : {}),
          treeComplete: view.treeComplete,
          ...(deps.root !== undefined ? { root: deps.root } : {}),
        });

        // A hunk re-anchored by content (its header named another line) or
        // matched ignoring edge whitespace is said so on the row, after the
        // verdict's own reason; the verdict itself is unchanged.
        const reason =
          applied.notes.length > 0
            ? `${verdict.reason} Applied by content: ${applied.notes.join(' ')}`
            : verdict.reason;
        return finish(
          { status: verdict.status, code: verdict.code, reason },
          {
            ...drafted,
            diff: applied.canonicalDiff,
            verificationRuns: verdict.runs as unknown as Record<string, unknown>[],
          },
        );
      },
    );
    if (outcome === null) {
      return finish({
        status: 'failed',
        code: 'source_unavailable',
        reason: `${target.file} could not be read at commit ${row.commitSha.slice(0, 12)} (missing, binary, or over the forge's size limit).`,
      });
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof TierNotPermittedError
        ? 'tier3_not_opted_in'
        : err instanceof HostUnavailableError
          ? 'model_busy'
          : 'error';
    return finish({ status: 'failed', code, reason: message });
  }
}
