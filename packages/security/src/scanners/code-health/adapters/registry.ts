import { biomeAdapter } from './biome.js';
import { cppcheckAdapter } from './cppcheck.js';
import { ruffAdapter } from './ruff.js';
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
 */
export const DEDUP_MAP: { native: string; packRule: string; keep: 'pack' | 'tool' }[] = [
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
];

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
    // Every mapping for the native rule, not the first: E722 is a bare except
    // in both the JavaScript-era entry and the Python pack's, and whichever
    // of them fired in this repository is the one that covers it.
    const mapping = DEDUP_MAP.find(
      (m) => m.native === finding.nativeRule && m.keep === 'pack' && packSeen.has(m.packRule),
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

export { ruffAdapter, biomeAdapter, cppcheckAdapter };
export type { ToolAdapter, AdapterFinding, AdapterContext };
