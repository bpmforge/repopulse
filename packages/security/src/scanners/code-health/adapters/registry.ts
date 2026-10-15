import { actionlintAdapter } from './actionlint.js';
import { biomeAdapter } from './biome.js';
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
  // Hard-coded credentials (W18-26). The secrets scanner owns this defect:
  // it verifies the key's format, redacts it in the finding, and drives the
  // rotation advice. checkov's and actionlint's versions say "a credential is
  // here", which is the less useful half of the same row.
  { native: 'CKV_AWS_41', packRule: 'aws-access-key-id', keep: 'pack' },
  { native: 'CKV_AWS_41', packRule: 'aws-secret-access-key', keep: 'pack' },
  { native: 'credentials', packRule: 'generic-secret-assignment', keep: 'pack' },
];

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
    // than one pack rule (CKV_AWS_41 covers both halves of an AWS key pair).
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

export {
  ruffAdapter,
  biomeAdapter,
  actionlintAdapter,
  shellcheckAdapter,
  hadolintAdapter,
  checkovAdapter,
};
export type { ToolAdapter, AdapterFinding, AdapterContext };
