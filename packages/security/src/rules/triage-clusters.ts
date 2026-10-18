import { security, type Database, safeErrorText } from '@repopulse/shared';
import type { AnalysisGateway } from '@repopulse/analysis';
import type { TriageVerdict } from '../triage/types.js';
import { acceptDraft, type FpCluster } from './intake.js';

// Rule-tweak proposals from AI-judged false positives (W19-06).
//
// W19-04's triage role says, per finding, real / likely false positive / needs a
// human. When it keeps calling the SAME rule a false positive, that is a signal
// the rule is too broad - and it is the only kind of signal the AI is trusted to
// raise here: a PROPOSAL, written down for a person.
//
// NOTHING IN THIS FILE CHANGES A RULE. A tweak lands in the rule registry as
// `proposed` with provenance `llm_draft:ai_triage`, set here and never taken
// from the model, and `proposed` is the first rung of the same lifecycle every
// other drafted rule climbs: shadow, evidence, and an admin's decision
// (lifecycle.ts). The AI's verdicts are evidence for the proposal, not a vote.
//
// THREE GUARDS, each because the alternative is a worse rule than the noisy one:
//   - Only CONFIDENT false-positive verdicts count (default confidence >= 3).
//   - A cluster needs MORE false positives than real verdicts for the same
//     rule. A rule the model mostly agrees with is not tweaked on a minority.
//   - The REAL verdicts for that rule go into the prompt as cases the narrower
//     rule must still catch, and the drafted rule needs a clean fixture AND a
//     trigger fixture (the validator already requires both).

export interface TriageJudgement {
  ruleId: string | null;
  file: string | null;
  evidence: string;
  verdict: TriageVerdict;
  confidence: number;
  /** The lines the model cited, as OUR copy has them (W19-04). */
  citedLines: string[];
  rationale: string;
}

export interface TriageFpCluster extends FpCluster {
  origin: 'ai_triage';
  /** What the model said about each, so the proposal is reviewable on its own. */
  rationales: string[];
  /** Real verdicts for the same rule: the narrower rule must still catch these. */
  mustStillCatch: { file: string; evidence: string }[];
  realCount: number;
  needsHumanCount: number;
}

export interface TriageClusterOptions {
  minSize?: number;
  minConfidence?: number;
}

export function clusterTriageFalsePositives(
  judgements: readonly TriageJudgement[],
  options: TriageClusterOptions = {},
): TriageFpCluster[] {
  const minSize = options.minSize ?? 3;
  const minConfidence = options.minConfidence ?? 3;
  const byRule = new Map<string, TriageJudgement[]>();
  for (const j of judgements) {
    // A finding with no rule has nothing to tweak.
    if (j.ruleId === null) continue;
    byRule.set(j.ruleId, [...(byRule.get(j.ruleId) ?? []), j]);
  }

  const out: TriageFpCluster[] = [];
  for (const [ruleId, items] of byRule) {
    const fps = items.filter(
      (j) => j.verdict === 'likely_false_positive' && j.confidence >= minConfidence,
    );
    const real = items.filter((j) => j.verdict === 'real');
    const needsHuman = items.filter((j) => j.verdict === 'needs_human');
    // A cluster of one or two is a disagreement, not a pattern.
    if (fps.length < minSize) continue;
    // A rule the model mostly confirms is working; do not tweak it on a minority.
    if (fps.length <= real.length) continue;
    out.push({
      origin: 'ai_triage',
      sourceRuleId: ruleId,
      size: fps.length,
      samples: fps.slice(0, 5).map((j) => ({
        file: j.file ?? '(repo-level)',
        evidence: [j.evidence, ...j.citedLines.slice(0, 2)].join(' | '),
      })),
      rationales: fps.slice(0, 5).map((j) => j.rationale),
      mustStillCatch: real
        .slice(0, 5)
        .map((j) => ({ file: j.file ?? '(repo-level)', evidence: j.evidence })),
      realCount: real.length,
      needsHumanCount: needsHuman.length,
    });
  }
  return out.sort(
    (a, b) => b.size - a.size || (a.sourceRuleId ?? '').localeCompare(b.sourceRuleId ?? ''),
  );
}

/** The prompt. Honest about where the examples came from, and firm about what must still match. */
export function buildTweakPrompt(cluster: TriageFpCluster): string {
  return [
    'You are refining a static-analysis ruleset.',
    '',
    `Rule ${cluster.sourceRuleId} fired on ${cluster.size} findings that an AI reviewer judged to be`,
    'false positives. These are AI judgements, NOT confirmed by a person; treat them as',
    'hypotheses about why the rule is too broad, and say in your rationale what pattern you',
    'think separates them from real cases.',
    '',
    'Propose ONE narrower rule that stops matching these while still matching the real cases',
    'listed below. Return JSON only:',
    '',
    '{"id":"{domain}.{slug}","domain":"slop|logging|perf|correctness|framework",',
    '"layer":"llm","languages":["javascript"],"severity":1-5,',
    '"checklistItem":"the question a reviewer should ask","fixtures":{"trigger":["..."],"clean":["..."]},',
    '"rationale":"what changed and why these examples no longer match"}',
    '',
    'BOTH fixtures are required: a trigger case the rule must catch and a clean case it must not.',
    '',
    "--- judged false positives (the reviewer's reasons follow each) ---",
    ...cluster.samples.map(
      (s, i) => `${s.file}: ${s.evidence}\n  reviewer: ${cluster.rationales[i] ?? ''}`,
    ),
    '',
    cluster.mustStillCatch.length > 0
      ? '--- real findings of this same rule: the narrower rule MUST still match these ---'
      : '--- no real findings of this rule were seen in this batch ---',
    ...cluster.mustStillCatch.map((s) => `${s.file}: ${s.evidence}`),
  ].join('\n');
}

export interface TweakPassDeps {
  db: Database;
  workspaceId: number;
  gateway?: AnalysisGateway | undefined;
  judgements: readonly TriageJudgement[];
  now?: Date;
  maxProposals?: number;
  minClusterSize?: number;
  minConfidence?: number;
}

export interface TweakPassResult {
  status: 'succeeded' | 'skipped' | 'failed';
  skippedReason?: 'no_gateway' | 'no_clusters';
  clusters: number;
  proposed: number;
  rejected: number;
  error?: string;
}

export async function runTriageTweakPass(deps: TweakPassDeps): Promise<TweakPassResult> {
  const empty = { clusters: 0, proposed: 0, rejected: 0 };
  if (!deps.gateway) return { status: 'skipped', skippedReason: 'no_gateway', ...empty };

  const clusters = clusterTriageFalsePositives(deps.judgements, {
    ...(deps.minClusterSize !== undefined ? { minSize: deps.minClusterSize } : {}),
    ...(deps.minConfidence !== undefined ? { minConfidence: deps.minConfidence } : {}),
  });
  if (clusters.length === 0) return { status: 'skipped', skippedReason: 'no_clusters', ...empty };

  const now = deps.now ?? new Date();
  let proposed = 0;
  let rejected = 0;
  try {
    for (const cluster of clusters.slice(0, deps.maxProposals ?? 3)) {
      const result = await deps.gateway.complete(buildTweakPrompt(cluster), {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: '0',
          prNumber: 0,
          dimension: 'code_health',
          checklistVersion: 'rule_tweak.v1',
          initiator: 'scheduler:rule_tweak_from_triage',
          role: 'triage',
        },
      });
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        rejected += 1;
        continue;
      }
      // Status and provenance are set by acceptDraft, never by the model.
      const draft = acceptDraft(raw, now, 'llm_draft:ai_triage');
      if (!draft.ok || !draft.rule) {
        rejected += 1;
        continue;
      }
      await deps.db
        .insert(security.ruleRegistry)
        .values({
          workspaceId: deps.workspaceId,
          ruleId: draft.rule.id,
          status: 'proposed',
          provenance: draft.rule.provenance as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing();
      proposed += 1;
    }
  } catch (error) {
    return {
      status: 'failed',
      clusters: clusters.length,
      proposed,
      rejected,
      error: safeErrorText(error),
    };
  }
  return { status: 'succeeded', clusters: clusters.length, proposed, rejected };
}
