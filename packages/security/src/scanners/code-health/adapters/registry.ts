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
    const mapping = DEDUP_MAP.find((m) => m.native === finding.nativeRule);
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
