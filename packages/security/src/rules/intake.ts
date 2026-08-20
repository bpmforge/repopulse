import { validateHealthRule, type HealthRule } from './schema.js';

// Rule intake (W9-07, CODE_HEALTH_SUITE.md §8.3, FR-CH-9).
//
// Two doors, and NEITHER of them leads straight to `active`.
//
//   1. A person proposes a rule from a finding or a cluster of false positives.
//   2. A scheduled T2 pass clusters false-positive dismissals and DRAFTS a
//      rule, with both fixtures, marked provenance.source = 'llm_draft'.
//
// A drafted rule lands `proposed` and can go no further without an admin. That
// is not ceremony: a model that writes a rule from a cluster of dismissals is
// pattern-matching on the thing people already said was wrong, and its output
// is a suggestion about a suggestion.

export interface FpCluster {
  /** The rule whose findings were dismissed, if they came from one. */
  sourceRuleId: string | null;
  /** How many dismissals are in this cluster. */
  size: number;
  /** Representative evidence quotes — the prompt's grounding. */
  samples: { file: string; evidence: string }[];
}

/** Clusters false-positive dismissals by rule and file shape. */
export function clusterDismissals(
  dismissals: readonly { ruleId: string | null; file: string | null; evidence: string }[],
  minSize = 3,
): FpCluster[] {
  const byRule = new Map<string, typeof dismissals[number][]>();
  for (const d of dismissals) {
    const key = d.ruleId ?? 'unattributed';
    const list = byRule.get(key) ?? [];
    list.push(d);
    byRule.set(key, list);
  }

  return [...byRule.entries()]
    // A cluster of one or two is a disagreement, not a pattern. Drafting a
    // rule from it would encode one reviewer's Tuesday into the product.
    .filter(([, items]) => items.length >= minSize)
    .map(([ruleId, items]) => ({
      sourceRuleId: ruleId === 'unattributed' ? null : ruleId,
      size: items.length,
      samples: items.slice(0, 5).map((i) => ({ file: i.file ?? '(repo-level)', evidence: i.evidence })),
    }))
    .sort((a, b) => b.size - a.size);
}

/** The prompt for a drafting pass. Grounded in the cluster, nothing else. */
export function buildDraftPrompt(cluster: FpCluster): string {
  return [
    'You are refining a static-analysis ruleset.',
    '',
    `${cluster.size} findings${cluster.sourceRuleId ? ` from rule ${cluster.sourceRuleId}` : ''} were`,
    'dismissed as false positives. Below are representative examples.',
    '',
    'Propose ONE narrower rule that would still catch the real cases while not',
    'matching these. Return JSON only:',
    '',
    '{"id":"{domain}.{slug}","domain":"slop|logging|perf|correctness|framework",',
    '"layer":"pack","languages":["javascript"],"severity":1-5,',
    '"engineRule":"path/to/pack.yaml","fixtures":{"trigger":["..."],"clean":["..."]},',
    '"rationale":"what changed and why these examples no longer match"}',
    '',
    'BOTH fixtures are required. A rule with no clean fixture has never been',
    'shown NOT to fire, which is the failure this exercise exists to fix.',
    '',
    '--- dismissed examples ---',
    ...cluster.samples.map((s) => `${s.file}: ${s.evidence}`),
  ].join('\n');
}

export interface DraftResult {
  ok: boolean;
  rule?: HealthRule;
  error?: string;
}

/**
 * Turns a model's draft into a PROPOSED rule, or rejects it.
 *
 * The status and provenance are set HERE, never taken from the model: a draft
 * that could name its own status could propose itself active, and a draft that
 * could name its own provenance could claim to be ours.
 */
export function acceptDraft(raw: unknown, now: Date): DraftResult {
  const candidate = {
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
    status: 'proposed' as const,
    provenance: {
      source: 'llm_draft',
      license: 'UNLICENSED-REPOPULSE',
      author: 'analysis-gateway',
      date: now.toISOString().slice(0, 10),
    },
  };

  try {
    return { ok: true, rule: validateHealthRule(candidate) };
  } catch (err) {
    // A draft that fails validation is DISCARDED, not stored for someone to
    // fix later: a half-formed rule in the queue is a rule an admin will
    // eventually approve without reading.
    return { ok: false, error: (err as Error).message };
  }
}
