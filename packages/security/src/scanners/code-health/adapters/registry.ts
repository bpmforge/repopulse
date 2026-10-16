import { actionlintAdapter } from './actionlint.js';
import { biomeAdapter } from './biome.js';
import { cppcheckAdapter } from './cppcheck.js';
import { checkovAdapter } from './checkov.js';
import { hadolintAdapter } from './hadolint.js';
import { ruffAdapter } from './ruff.js';
import { shellcheckAdapter } from './shellcheck.js';
import type { AdapterContext, AdapterFinding, ToolAdapter } from './types.js';

// The adapter registry (W9-08, CODE_HEALTH_SUITE.md §10, FR-CH-10).
//
// Adding a tool is ONE file and ONE line here. Nothing else in the scanner
// knows a tool's name — applicability, argv and parsing are all asked of the
// adapter, which is what makes that claim checkable rather than aspirational.

const registry = new Map<string, ToolAdapter>();

export function registerAdapter(adapter: ToolAdapter): void {
  const existing = registry.get(adapter.key);
  if (existing && existing !== adapter) {
    // Loud, like the scanner registry (W8-01): the key is stamped onto every
    // finding, so a duplicate would attribute one tool's output to another.
    throw new Error(`Tool adapter "${adapter.key}" is already registered.`);
  }
  registry.set(adapter.key, adapter);
}

export function listAdapters(): ToolAdapter[] {
  return [...registry.values()];
}

export function resetAdapters(): void {
  registry.clear();
  registerAdapter(ruffAdapter);
  registerAdapter(biomeAdapter);
  registerAdapter(cppcheckAdapter);
  registerAdapter(actionlintAdapter);
  registerAdapter(shellcheckAdapter);
  registerAdapter(hadolintAdapter);
  registerAdapter(checkovAdapter);
}

resetAdapters();

/** Adapters that apply to this snapshot — the language routing (§10). */
export function adaptersFor(ctx: AdapterContext): ToolAdapter[] {
  return listAdapters().filter((adapter) => adapter.detect(ctx));
}

/**
 * Native rules that duplicate a pack rule, and which source wins.
 *
 * When two tools describe the SAME defect, the one that says it with less
 * noise is kept. The alternative — reporting both — hands a reader two rows
 * for one problem and makes them do the deduplication by eye, every time.
 *
 * `tool` (W18-24) scopes an entry to one tool's rule namespace. Our in-sandbox
 * adapters had globally distinctive ids (E722, lint/suspicious/…), so the map
 * never needed it; external SARIF and code-scanning results do — eslint's
 * `no-empty` and some other linter's `no-empty` need not mean the same thing.
 * An entry WITHOUT a tool matches that native id from any tool, which is what
 * keeps ruff's E722 deduped whether it arrives from our sandbox or a SARIF file.
 *
 * `keep: 'tool'` rows drop nothing. They record that the overlap was looked at
 * and the other tool's finding is the better one (a taint-tracked CodeQL query
 * against our pattern rule) — so both stay, and the mapping is explicit.
 * Entries name rules by their published IDS only; no rule text is used.
 */
export const DEDUP_MAP: {
  native: string;
  packRule: string;
  keep: 'pack' | 'tool';
  tool?: string;
}[] = [
  // Our own rule carries the reasoning about WHY a swallowed failure matters;
  // ruff's E722 says "do not use bare except".
  { native: 'E722', packRule: 'bpm-ch-empty-catch', keep: 'pack' },
  // Biome's noDoubleEquals is more precise than anything we have written, and
  // we have no pack rule for it — kept, and listed so the mapping is complete
  // rather than implicit.
  { native: 'lint/suspicious/noDoubleEquals', packRule: '', keep: 'tool' },
  // Both flag console usage; ours knows about the production-path exclusions.
  { native: 'lint/suspicious/noConsoleLog', packRule: 'bpm-log-console-in-prod', keep: 'pack' },
  { native: 'lint/suspicious/noConsole', packRule: 'bpm-log-console-in-prod', keep: 'pack' },
  // cppcheck (W18-15) against the C/C++ SAST pack. Ours wins each pair: the
  // pack finding is the one in the security dimension, carrying the CWE and
  // the reason the shape is dangerous; cppcheck's says what it saw. Ids
  // verified against cppcheck 2.22.0 output on the pack's triggering fixture.
  { native: 'getsCalled', packRule: 'bpm-c-gets', keep: 'pack' },
  { native: 'invalidscanf', packRule: 'bpm-c-scanf-unbounded-string', keep: 'pack' },
  { native: 'pointerSize', packRule: 'bpm-c-memcpy-sizeof-pointer', keep: 'pack' },
  { native: 'memleakOnRealloc', packRule: 'bpm-c-realloc-self-assign', keep: 'pack' },
  // cppcheck also reports CONSTANT-size alloca; ours deliberately does not.
  // Once our rule is firing in a repository, the constant-size ones are the
  // noise our rule was written to leave out.
  { native: 'allocaCalled', packRule: 'bpm-c-alloca-variable-size', keep: 'pack' },
  // cppcheck's null-after-allocation family is dataflow-based and catches
  // writes our straight-line pattern cannot see. It still loses the pair
  // when both fire, so one defect is one row; when ours is silent (the more
  // common case, since ours errs towards silence) cppcheck's is kept.
  { native: 'nullPointerOutOfMemory', packRule: 'bpm-c-alloc-unchecked', keep: 'pack' },
  { native: 'nullPointerArithmeticOutOfMemory', packRule: 'bpm-c-alloc-unchecked', keep: 'pack' },
  { native: 'ctunullpointerOutOfMemory', packRule: 'bpm-c-alloc-unchecked', keep: 'pack' },
  // Hard-coded credentials (W18-26). The secrets scanner owns this defect:
  // it verifies the key's format, redacts it in the finding, and drives the
  // rotation advice. checkov's and actionlint's versions say "a credential is
  // here", which is the less useful half of the same row.
  { native: 'CKV_AWS_41', packRule: 'aws-access-key-id', keep: 'pack' },
  { native: 'CKV_AWS_41', packRule: 'aws-secret-access-key', keep: 'pack' },
  { native: 'credentials', packRule: 'generic-secret-assignment', keep: 'pack' },

  // Python (W18-11). ruff runs with E7, F, B, S and C90 selected (ruff.ts), so
  // the flake8-bandit S rules overlap the Python baseline and anti-slop packs.
  // `pack` only where ruff's rule and ours describe the SAME defect: matching
  // is by rule identity across the whole repository, so a broader ruff rule
  // mapped to a narrower pack rule would lose every finding outside the
  // narrow one's reach the moment the narrow one fired once.
  { native: 'E722', packRule: 'bpm-ch-bare-except-py', keep: 'pack' },
  // try/except/pass.
  { native: 'S110', packRule: 'bpm-ch-empty-except-py', keep: 'pack' },
  { native: 'S307', packRule: 'bpm-py-eval-dynamic', keep: 'pack' },
  { native: 'S102', packRule: 'bpm-py-eval-dynamic', keep: 'pack' },
  // Both honour usedforsecurity=False; same defect, ours says what to do.
  { native: 'S324', packRule: 'bpm-py-weak-hash', keep: 'pack' },
  // SQL-looking string built by formatting — the same question ours asks.
  { native: 'S608', packRule: 'bpm-py-sql-string-build', keep: 'pack' },
  // Broader than ours: S602 is any shell=True, S605 any os.system, S311 any
  // use of `random`. Ours fire only on a spliced command or a secret-named
  // target, so ruff's are kept — listed so the overlap is explicit.
  { native: 'S602', packRule: 'bpm-py-subprocess-shell-concat', keep: 'tool' },
  { native: 'S605', packRule: 'bpm-py-subprocess-shell-concat', keep: 'tool' },
  { native: 'S311', packRule: 'bpm-py-random-token', keep: 'tool' },
  // Same family, different claims (W18-04): Biome reports EACH explicit any at
  // its line; slop.suppression_density reports a RATE, for the repository or
  // an outlier file, and never points at a single any. 'pack' would drop every
  // per-line hit the moment the rate finding exists anywhere in the repository
  // — the actionable rows lost to the summary of them. So the tool keeps its
  // findings, and the rate rule deliberately emits none per hit.
  {
    native: 'lint/suspicious/noExplicitAny',
    packRule: 'slop.suppression_density',
    keep: 'tool',
  },
  // --- External tools (W18-24): SARIF uploads and GitHub code scanning. ---
  // ESLint core rules that say what one of ours says, with less context.
  { tool: 'eslint', native: 'no-empty', packRule: 'bpm-ch-empty-catch', keep: 'pack' },
  { tool: 'eslint', native: 'no-console', packRule: 'bpm-log-console-in-prod', keep: 'pack' },
  { tool: 'eslint', native: 'no-eval', packRule: 'bpm-js-eval-dynamic', keep: 'pack' },
  { tool: 'eslint', native: 'no-await-in-loop', packRule: 'bpm-perf-await-in-loop', keep: 'pack' },
  // CodeQL queries that follow data flow where ours matches a shape: where
  // both fire, CodeQL has proved the source reaches the sink and ours has not,
  // so its finding is the one worth reading. Both kept.
  {
    tool: 'codeql',
    native: 'js/sql-injection',
    packRule: 'bpm-js-sql-string-concat',
    keep: 'tool',
  },
  {
    tool: 'codeql',
    native: 'js/command-line-injection',
    packRule: 'bpm-js-child-process-concat',
    keep: 'tool',
  },
  { tool: 'codeql', native: 'js/code-injection', packRule: 'bpm-js-eval-dynamic', keep: 'tool' },
  {
    tool: 'codeql',
    native: 'js/insecure-randomness',
    packRule: 'bpm-js-math-random-token',
    keep: 'tool',
  },
  { tool: 'codeql', native: 'js/log-injection', packRule: 'bpm-log-injection', keep: 'tool' },
  // A weak-hash finding has no data flow to prove; ours names the fix.
  {
    tool: 'codeql',
    native: 'js/weak-cryptographic-algorithm',
    packRule: 'bpm-js-weak-hash',
    keep: 'pack',
  },
];

/**
 * The pack rule an external tool's native rule duplicates, if it should yield.
 *
 * Two routes: a DEDUP_MAP entry with `keep: 'pack'` (scoped to this tool, or
 * unscoped), or IDENTITY — a team running our own `bpm-*` pack in their CI and
 * uploading the SARIF produces our rule under our id, possibly prefixed with
 * the config path semgrep stamps on (`rulepacks.semgrep.bpm-js-eval-dynamic`).
 * Null when the external finding stands on its own.
 */
export function packRuleSupersedingExternal(tool: string, nativeRule: string): string | null {
  const mapping = DEDUP_MAP.find(
    (m) => m.native === nativeRule && (m.tool === undefined || m.tool === tool),
  );
  if (mapping) return mapping.keep === 'pack' && mapping.packRule !== '' ? mapping.packRule : null;
  const lastSegment = nativeRule.split('.').pop() ?? nativeRule;
  return /^bpm-[a-z0-9-]+$/.test(lastSegment) ? lastSegment : null;
}

/**
 * Two ADAPTERS reporting the same defect in the same file (W18-26).
 *
 * checkov's Dockerfile checks and hadolint overlap on four defects. Unlike the
 * pack map above, both sources run in the same scan, so this is matched on
 * rule AND file: the pair only collapses when both tools flagged the same
 * Dockerfile. Which one is kept is per pair — hadolint for Dockerfile hygiene
 * (it points at the exact instruction and knows the build semantics), checkov
 * for the root-user check, because that one is a privilege finding and
 * belongs in the iac dimension with the other privilege findings.
 */
export const TOOL_DEDUP_MAP: { keep: string; drop: string }[] = [
  { keep: 'tool.hadolint.DL3007', drop: 'tool.checkov.CKV_DOCKER_7' },
  { keep: 'tool.hadolint.DL3000', drop: 'tool.checkov.CKV_DOCKER_10' },
  { keep: 'tool.hadolint.DL3024', drop: 'tool.checkov.CKV_DOCKER_11' },
  { keep: 'tool.checkov.CKV_DOCKER_8', drop: 'tool.hadolint.DL3002' },
];

/**
 * Drops one adapter's finding when another adapter reported the same defect
 * in the same file, per TOOL_DEDUP_MAP.
 */
export function dedupeAcrossTools(findings: readonly AdapterFinding[]): {
  kept: AdapterFinding[];
  dropped: { ruleId: string; because: string }[];
} {
  const present = new Set(findings.map((f) => `${f.ruleId}\u0000${f.file}`));
  const kept: AdapterFinding[] = [];
  const dropped: { ruleId: string; because: string }[] = [];
  for (const finding of findings) {
    const pair = TOOL_DEDUP_MAP.find(
      (m) => m.drop === finding.ruleId && present.has(`${m.keep}\u0000${finding.file}`),
    );
    if (pair) {
      dropped.push({
        ruleId: finding.ruleId,
        because: `${pair.keep} already reports this defect in ${finding.file}`,
      });
      continue;
    }
    kept.push(finding);
  }
  return { kept, dropped };
}

/**
 * Drops adapter findings a pack rule already reported for the same defect.
 *
 * Matched on rule identity, NOT on file and line: two tools flagging the same
 * line for different reasons are two findings, and collapsing them by position
 * would silently lose one.
 */
export function dedupeAgainstPack(
  adapterFindings: readonly AdapterFinding[],
  packRuleIds: readonly string[],
): { kept: AdapterFinding[]; dropped: { ruleId: string; because: string }[] } {
  const packSeen = new Set(packRuleIds);
  const kept: AdapterFinding[] = [];
  const dropped: { ruleId: string; because: string }[] = [];

  for (const finding of adapterFindings) {
    // ANY matching row, not the first: one native rule can duplicate more
    // than one pack rule (CKV_AWS_41 covers both halves of an AWS key pair;
    // E722 is a bare except in the JavaScript-era entry and the Python pack's),
    // and whichever of them fired in this repository is the one that covers it.
    // ruleId is `tool.{key}.{rule}`; a tool-scoped entry only applies to its tool.
    const adapterKey = finding.ruleId.split('.')[1];
    const mapping = DEDUP_MAP.find(
      (m) =>
        m.native === finding.nativeRule &&
        (m.tool === undefined || m.tool === adapterKey) &&
        m.keep === 'pack' &&
        packSeen.has(m.packRule),
    );
    if (mapping) {
      dropped.push({
        ruleId: finding.ruleId,
        because: `${mapping.packRule} already reports this defect, and it explains why it matters`,
      });
      continue;
    }
    kept.push(finding);
  }
  return { kept, dropped };
}

export {
  ruffAdapter,
  biomeAdapter,
  cppcheckAdapter,
  actionlintAdapter,
  shellcheckAdapter,
  hadolintAdapter,
  checkovAdapter,
};
export type { ToolAdapter, AdapterFinding, AdapterContext };
