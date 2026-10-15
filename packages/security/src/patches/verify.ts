import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dedupKey } from '@repopulse/insights';
import { shred, snapshotRoot, SNAPSHOT_PREFIX } from '../snapshot/snapshot.js';
import type { SourceFile } from '../snapshot/sources.js';

// Verification for model-drafted patches (W18-19, D16).
//
// THE VERIFIER IS NOT A MODEL. The analysis tiers' maker≠verifier rule exists
// because a model asked "was I right?" agrees with itself; the same failure
// would be worse here, where the claim is "this code is now safe". So the
// verdict comes from re-running the deterministic rules — the same packs and
// in-process rules that raised findings in the first place — over the file
// before and after the patch, in the same scratch dir, under the same
// conditions. A model's opinion of its own fix is not consulted at all.
//
// BEFORE IS RE-SCANNED TOO, not read from the findings table. A stored finding
// may come from a whole-tree run, an older rulepack, or a scanner whose
// evidence format has since moved; comparing a fresh after-scan with a stale
// before-record would make "cleared" mean "the two runs differed". Re-scanning
// both makes the comparison like-for-like, and a target that does not
// reproduce in the before-scan is REJECTED — clearing a finding nobody can
// reproduce proves nothing.

/** One rule match, in the fields the findings store keys on. */
export interface RuleHit {
  scannerKey: string;
  ruleId: string;
  dimension: string;
  file: string;
  lineStart: number | null;
  evidenceQuote: string;
  title: string;
}

export interface RuleRunOutput {
  status: 'succeeded' | 'failed' | 'skipped';
  hits: RuleHit[];
  /** Why it failed or was skipped, in words that can reach a screen. */
  reason?: string;
  toolVersions?: Record<string, string>;
}

export interface RuleRunInput {
  /** A directory containing `file` at its repository-relative path, and nothing else. */
  dir: string;
  file: string;
  /** The file's content in this state. */
  source: string;
  /**
   * The repository's sources with `file` replaced by this state's content.
   * Absent when no snapshot tree was available; whole-tree rules then skip.
   */
  tree?: readonly SourceFile[];
  treeComplete: boolean;
}

/**
 * A set of rules that can be re-run over one file.
 *
 * `scannerKeys` names the stored findings this runner reproduces: a target
 * from a scanner no runner reproduces cannot be verified, and is rejected as
 * such rather than "verified" by a run that never looked for it.
 */
export interface FileRuleRunner {
  key: string;
  scannerKeys: readonly string[];
  run(input: RuleRunInput): Promise<RuleRunOutput>;
}

export interface PatchTarget {
  dedupKey: string;
  scannerKey: string | null;
  ruleId: string | null;
  file: string;
}

/** One runner execution, stored on the patch row (W18-19 "verification run ids"). */
export interface VerificationRun {
  id: string;
  runner: string;
  state: 'before' | 'after';
  status: RuleRunOutput['status'];
  hits: number;
  durationMs: number;
  reason?: string;
  toolVersions?: Record<string, string>;
}

export type PatchVerdictCode =
  | 'verified'
  | 'not_rerunnable'
  | 'target_not_reproduced'
  | 'target_still_present'
  | 'target_moved'
  | 'new_finding'
  | 'rule_run_failed';

export interface PatchVerdict {
  status: 'verified' | 'rejected' | 'failed';
  code: PatchVerdictCode;
  reason: string;
}

/** The store's key for a hit — the same function the findings store uses. */
export function hitDedupKey(hit: RuleHit): string {
  return dedupKey({
    dimension: hit.dimension,
    file: hit.file,
    evidenceQuote: hit.evidenceQuote,
    lineStart: hit.lineStart,
    scannerKey: hit.scannerKey,
    ruleId: hit.ruleId,
  });
}

function ruleIdentity(hit: { scannerKey: string | null; ruleId: string | null }): string {
  return `${hit.scannerKey ?? ''}\0${hit.ruleId ?? ''}`;
}

function countByRule(hits: readonly RuleHit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(ruleIdentity(hit), (counts.get(ruleIdentity(hit)) ?? 0) + 1);
  return counts;
}

/**
 * The verdict, from the two scans.
 *
 * Verified iff ALL of:
 *   1. some runner that reproduces the target's scanner ran on both states;
 *   2. every runner that ran succeeded on both (a failed run cannot vouch that
 *      nothing new appeared);
 *   3. the target's dedup key is present before and absent after;
 *   4. its rule fires FEWER times after than before — the dedup key carries a
 *      ten-line bucket, so a patch that inserts lines above the finding moves
 *      its key without fixing anything, and only the count catches that;
 *   5. no rule fires MORE times after than before. Counted per rule rather
 *      than compared by key for the same reason: an inserted line shifts the
 *      keys of every finding below it, and a key comparison would call each of
 *      them new.
 */
export function judgePatch(args: {
  target: PatchTarget;
  runners: readonly FileRuleRunner[];
  before: ReadonlyMap<string, RuleRunOutput>;
  after: ReadonlyMap<string, RuleRunOutput>;
}): PatchVerdict {
  const { target } = args;
  const covering = args.runners.filter(
    (r) =>
      target.scannerKey !== null &&
      r.scannerKeys.includes(target.scannerKey) &&
      args.before.get(r.key)?.status !== 'skipped',
  );
  if (covering.length === 0) {
    return {
      status: 'rejected',
      code: 'not_rerunnable',
      reason: `No deterministic rule set can re-check findings from ${target.scannerKey ?? 'this source'} on a single file, so a fix for it cannot be verified.`,
    };
  }

  for (const runner of args.runners) {
    for (const [state, outputs] of [
      ['before', args.before],
      ['after', args.after],
    ] as const) {
      const out = outputs.get(runner.key);
      if (out?.status === 'failed') {
        return {
          status: 'failed',
          code: 'rule_run_failed',
          reason: `The ${runner.key} rules could not be run on the ${state === 'before' ? 'original' : 'patched'} file (${out.reason ?? 'no reason given'}), so the patch could not be checked.`,
        };
      }
    }
  }

  const collect = (outputs: ReadonlyMap<string, RuleRunOutput>): RuleHit[] =>
    args.runners.flatMap((r) => {
      const out = outputs.get(r.key);
      return out?.status === 'succeeded' ? out.hits.filter((h) => h.file === target.file) : [];
    });
  const beforeHits = collect(args.before);
  const afterHits = collect(args.after);

  if (!beforeHits.some((h) => hitDedupKey(h) === target.dedupKey)) {
    return {
      status: 'rejected',
      code: 'target_not_reproduced',
      reason:
        'Re-scanning the original file did not reproduce this finding, so clearing it would prove nothing.',
    };
  }
  if (afterHits.some((h) => hitDedupKey(h) === target.dedupKey)) {
    return {
      status: 'rejected',
      code: 'target_still_present',
      reason: 'The finding is still reported on the patched file.',
    };
  }

  const beforeCounts = countByRule(beforeHits);
  const afterCounts = countByRule(afterHits);
  const targetRule = ruleIdentity(target);
  if ((afterCounts.get(targetRule) ?? 0) >= (beforeCounts.get(targetRule) ?? 0)) {
    return {
      status: 'rejected',
      code: 'target_moved',
      reason: `Rule ${target.ruleId ?? '(unnamed)'} fires as often on the patched file as before — the finding moved rather than cleared.`,
    };
  }

  const grew = [...afterCounts.entries()]
    .filter(([rule, n]) => n > (beforeCounts.get(rule) ?? 0))
    .map(([rule]) => rule.split('\0')[1] ?? rule);
  if (grew.length > 0) {
    return {
      status: 'rejected',
      code: 'new_finding',
      reason: `The patch introduces a new finding in the file: ${grew.sort().join(', ')}.`,
    };
  }

  return {
    status: 'verified',
    code: 'verified',
    reason: 'The finding clears on the patched file and no rule fires that did not fire before.',
  };
}

function withFile(
  tree: readonly SourceFile[] | undefined,
  file: string,
  source: string,
): SourceFile[] | undefined {
  if (!tree) return undefined;
  const replaced = tree.filter((f) => f.path !== file);
  replaced.push({ path: file, source });
  return replaced;
}

/** Joins a repository-relative path under `dir`, refusing anything that escapes it. */
export function safeJoin(dir: string, file: string): string {
  const full = path.resolve(dir, file);
  const rel = path.relative(dir, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing a path outside the scratch directory: ${file}`);
  }
  return full;
}

export interface VerifyPatchArgs {
  target: PatchTarget;
  before: string;
  after: string;
  runners: readonly FileRuleRunner[];
  tree?: readonly SourceFile[];
  treeComplete?: boolean;
  /** Scratch root; defaults to the snapshot root the sandbox can mount. */
  root?: string;
}

export interface VerifyPatchResult extends PatchVerdict {
  runs: VerificationRun[];
}

/**
 * Writes both states into a scratch dir under the snapshot root, runs every
 * runner on each, and judges.
 *
 * Under the SNAPSHOT root with the snapshot prefix on purpose: the sandbox
 * runner mounts only directories under that root (W17-27), and the orphan
 * sweeper removes `snap-*` dirs a SIGKILL left behind. This is the same
 * customer source as a snapshot and gets exactly the same treatment — shredded
 * in a `finally`, swept if that never runs.
 */
export async function verifyPatch(args: VerifyPatchArgs): Promise<VerifyPatchResult> {
  const root = snapshotRoot(args.root !== undefined ? { root: args.root } : {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(root, SNAPSHOT_PREFIX));
  const runs: VerificationRun[] = [];

  try {
    const outputs = {
      before: new Map<string, RuleRunOutput>(),
      after: new Map<string, RuleRunOutput>(),
    };
    for (const state of ['before', 'after'] as const) {
      const dir = path.join(scratch, state);
      const source = state === 'before' ? args.before : args.after;
      const target = safeJoin(dir, args.target.file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, source, { mode: 0o600 });

      const tree = withFile(args.tree, args.target.file, source);
      for (const runner of args.runners) {
        const started = Date.now();
        let out: RuleRunOutput;
        try {
          out = await runner.run({
            dir,
            file: args.target.file,
            source,
            ...(tree ? { tree } : {}),
            treeComplete: args.treeComplete ?? false,
          });
        } catch (err) {
          // A runner that throws is a failed run, recorded as one — never a
          // clean scan of a file nobody scanned.
          out = {
            status: 'failed',
            hits: [],
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        outputs[state].set(runner.key, out);
        runs.push({
          id: randomUUID(),
          runner: runner.key,
          state,
          status: out.status,
          hits: out.hits.length,
          durationMs: Date.now() - started,
          ...(out.reason ? { reason: out.reason.slice(0, 500) } : {}),
          ...(out.toolVersions ? { toolVersions: out.toolVersions } : {}),
        });
      }
    }

    const verdict = judgePatch({
      target: args.target,
      runners: args.runners,
      before: outputs.before,
      after: outputs.after,
    });
    return { ...verdict, runs };
  } finally {
    await shred(scratch);
  }
}
