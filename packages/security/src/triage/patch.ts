import { PatchRejectedError, validateAndApply } from '../patches/diff.js';
import { isRerunnable } from '../patches/target.js';
import { verifyPatch, type FileRuleRunner } from '../patches/verify.js';
import type { SourceFile } from '../snapshot/sources.js';
import type { TriageCandidate, TriagePatch } from './types.js';

// The patch hand-off (W19-04). The model's diff is never trusted and never read
// for its own verdict: it is parsed, applied to OUR copy of the file, and the
// SAME deterministic rules that raised the finding are re-run before and after
// (patches/verify.ts, W18-19). A patch survives only if the finding is gone and
// no new one appeared. It is a proposal; nothing here writes to a repository.

export interface PatchProofDeps {
  runners: readonly FileRuleRunner[];
  tree?: readonly SourceFile[];
  treeComplete?: boolean;
  root?: string;
}

export async function proveTriagePatch(
  candidate: TriageCandidate,
  patchText: string,
  deps: PatchProofDeps | undefined,
): Promise<TriagePatch> {
  const { finding } = candidate;
  if (!deps) {
    return {
      diff: null,
      status: 'not_attempted',
      reason: 'no rule runners were supplied, so the patch cannot be verified and is not offered',
    };
  }
  if (!isRerunnable(finding.scannerKey, finding.ruleId)) {
    return {
      diff: null,
      status: 'rejected',
      reason: `no deterministic rule re-runs "${finding.ruleId}", so a fix cannot be proven and is not offered`,
    };
  }

  let applied;
  try {
    applied = validateAndApply({
      modelText: patchText,
      file: finding.file,
      source: candidate.source,
    });
  } catch (err) {
    if (err instanceof PatchRejectedError) {
      return { diff: null, status: 'rejected', reason: err.message };
    }
    throw err;
  }

  const verdict = await verifyPatch({
    target: {
      dedupKey: finding.dedupKey,
      scannerKey: finding.scannerKey,
      ruleId: finding.ruleId,
      file: finding.file,
    },
    before: candidate.source,
    after: applied.after,
    runners: deps.runners,
    ...(deps.tree ? { tree: deps.tree } : {}),
    ...(deps.treeComplete !== undefined ? { treeComplete: deps.treeComplete } : {}),
    ...(deps.root ? { root: deps.root } : {}),
  });

  return verdict.status === 'verified'
    ? { diff: applied.canonicalDiff, status: 'verified', reason: verdict.reason }
    : { diff: null, status: verdict.status, reason: verdict.reason };
}
