import { biomeAdapter } from './biome.js';
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
    // ruleId is `tool.{key}.{rule}`; a tool-scoped entry only applies to its tool.
    const adapterKey = finding.ruleId.split('.')[1];
    const mapping = DEDUP_MAP.find(
      (m) => m.native === finding.nativeRule && (m.tool === undefined || m.tool === adapterKey),
    );
    if (mapping && mapping.keep === 'pack' && packSeen.has(mapping.packRule)) {
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

export { ruffAdapter, biomeAdapter };
export type { ToolAdapter, AdapterFinding, AdapterContext };
