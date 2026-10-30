import { and, desc, eq, gte, isNotNull, isNull, or } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { HostUnavailableError, type AnalysisGateway } from '@repopulse/analysis';
import { TRIAGE_VERDICTS, type TriageVerdict } from '../triage/types.js';
import type { DraftPassResult } from './draft-run.js';
import { acceptDraft, type FpCluster } from './intake.js';
import { shippedRuleIds } from './shipped-ids.js';

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
  /**
   * Ids a proposal may not take (W22-06): shipped pack rules, this workspace's
   * registry and every rule that has raised a finding here. A registry row
   * overrides a rule's status BY ID (shadow.ts), so a proposal named after a
   * live rule would put it back in shadow. The cluster's own source rule is
   * always reserved.
   */
  reservedRuleIds?: ReadonlySet<string>;
}

export interface TweakPassResult {
  status: 'succeeded' | 'skipped' | 'failed';
  skippedReason?: 'no_gateway' | 'no_clusters' | 'model_busy';
  clusters: number;
  proposed: number;
  rejected: number;
  /** Drafts that named an existing rule: thrown away, the existing rule untouched. */
  collided: number;
  /** Calls that timed out or failed; each recorded, and the pass went on. */
  errors: number;
  error?: string;
}

/**
 * One proposal per cluster, never more than `maxProposals` model calls.
 *
 * A timeout or provider error on one cluster is recorded and the next cluster
 * still runs (W22-06): a weekly pass that gave up on the first slow answer
 * would, on a local model under load, never propose anything. Only when EVERY
 * call failed does the pass report `failed`.
 */
export async function runTriageTweakPass(deps: TweakPassDeps): Promise<TweakPassResult> {
  const empty = { clusters: 0, proposed: 0, rejected: 0, collided: 0, errors: 0 };
  if (!deps.gateway) return { status: 'skipped', skippedReason: 'no_gateway', ...empty };

  const clusters = clusterTriageFalsePositives(deps.judgements, {
    ...(deps.minClusterSize !== undefined ? { minSize: deps.minClusterSize } : {}),
    ...(deps.minConfidence !== undefined ? { minConfidence: deps.minConfidence } : {}),
  });
  if (clusters.length === 0) return { status: 'skipped', skippedReason: 'no_clusters', ...empty };

  const now = deps.now ?? new Date();
  const reserved = deps.reservedRuleIds ?? new Set<string>();
  let proposed = 0;
  let rejected = 0;
  let collided = 0;
  const errors: string[] = [];
  let modelBusy = false;
  const attempted = clusters.slice(0, deps.maxProposals ?? 3);
  for (const cluster of attempted) {
    try {
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
      // A NEW id or nothing: a proposal never takes the name of a rule that
      // exists, because a registry row with that name would re-status it.
      if (draft.rule.id === cluster.sourceRuleId || reserved.has(draft.rule.id)) {
        collided += 1;
        continue;
      }
      const inserted = await deps.db
        .insert(security.ruleRegistry)
        .values({
          workspaceId: deps.workspaceId,
          ruleId: draft.rule.id,
          status: 'proposed',
          provenance: draft.rule.provenance as unknown as Record<string, unknown>,
        })
        // An existing row of that id, whatever its status, is left exactly as it was.
        .onConflictDoNothing()
        .returning({ id: security.ruleRegistry.id });
      if (inserted.length === 0) {
        collided += 1;
        continue;
      }
      proposed += 1;
    } catch (error) {
      // Another caller holds the model. This is background work: stop and let
      // the next run propose, rather than queue behind a scan.
      if (error instanceof HostUnavailableError) {
        modelBusy = true;
        break;
      }
      errors.push(`${cluster.sourceRuleId ?? '(no rule)'}: ${safeErrorText(error)}`);
    }
  }
  if (modelBusy && proposed === 0 && rejected === 0 && collided === 0 && errors.length === 0) {
    return { status: 'skipped', skippedReason: 'model_busy', ...empty, clusters: clusters.length };
  }
  const error = errors.length > 0 ? errors.slice(0, 3).join('; ') : undefined;
  return {
    status: errors.length === attempted.length ? 'failed' : 'succeeded',
    clusters: clusters.length,
    proposed,
    rejected,
    collided,
    errors: errors.length,
    ...(error !== undefined ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// The scheduled pass over STORED verdicts (W22-06).
//
// W22-03's judge writes an `ai_triage_verdicts` row for every rule hit after a
// scan; until now nothing read them back for learning. The weekly
// `rule_draft_pass` job runs this beside the dismissal drafter: same
// workspace-scoped job, same workspace gateway, same Tier 2.
// ---------------------------------------------------------------------------

/** Verdicts older than this say less about the rule as it is now. */
export const TWEAK_WINDOW_DAYS = 30;

/**
 * This workspace's AI verdicts on rule hits, newest per finding.
 *
 * Left out: a verdict a PERSON dismissed (they disagreed with the model, so it
 * is not evidence), one a newer pass superseded, and second opinions (they
 * check a verdict already counted; counting both would vote twice).
 */
export async function loadTriageJudgements(
  db: Database,
  workspaceId: number,
  now: Date = new Date(),
  windowDays: number = TWEAK_WINDOW_DAYS,
): Promise<TriageJudgement[]> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const rows = await db
    .select({
      findingId: read.aiTriageVerdicts.findingId,
      verdict: read.aiTriageVerdicts.verdict,
      confidence: read.aiTriageVerdicts.confidence,
      rationale: read.aiTriageVerdicts.rationale,
      citations: read.aiTriageVerdicts.citations,
      ruleId: read.findings.ruleId,
      file: read.findings.file,
      evidence: read.findings.evidence,
    })
    .from(read.aiTriageVerdicts)
    .innerJoin(
      read.findings,
      and(
        eq(read.findings.id, read.aiTriageVerdicts.findingId),
        eq(read.findings.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(read.aiTriageVerdicts.workspaceId, workspaceId),
        isNull(read.aiTriageVerdicts.secondOpinionOf),
        or(isNull(read.aiTriageVerdicts.decision), eq(read.aiTriageVerdicts.decision, 'accepted')),
        gte(read.aiTriageVerdicts.createdAt, since),
        isNotNull(read.findings.ruleId),
      ),
    )
    .orderBy(desc(read.aiTriageVerdicts.createdAt), desc(read.aiTriageVerdicts.id))
    .limit(2000);

  const seen = new Set<number>();
  const out: TriageJudgement[] = [];
  for (const r of rows) {
    if (seen.has(r.findingId)) continue;
    seen.add(r.findingId);
    if (!(TRIAGE_VERDICTS as readonly string[]).includes(r.verdict)) continue;
    out.push({
      ruleId: r.ruleId,
      file: r.file,
      evidence: r.evidence,
      verdict: r.verdict as TriageVerdict,
      confidence: r.confidence,
      citedLines: r.citations.map((c) => c.text),
      rationale: r.rationale,
    });
  }
  return out;
}

/** Shipped pack ids, this workspace's registry ids, and every rule that raised a finding here. */
export async function reservedRuleIds(db: Database, workspaceId: number): Promise<Set<string>> {
  const out = new Set<string>(shippedRuleIds());
  const registry = await db
    .select({ ruleId: security.ruleRegistry.ruleId })
    .from(security.ruleRegistry)
    .where(eq(security.ruleRegistry.workspaceId, workspaceId));
  for (const r of registry) out.add(r.ruleId);
  const fired = await db
    .selectDistinct({ ruleId: read.findings.ruleId })
    .from(read.findings)
    .where(and(eq(read.findings.workspaceId, workspaceId), isNotNull(read.findings.ruleId)));
  for (const r of fired) if (r.ruleId) out.add(r.ruleId);
  return out;
}

export interface StoredTweakPassDeps {
  db: Database;
  workspaceId: number;
  gateway?: AnalysisGateway | undefined;
  now?: Date;
  maxProposals?: number;
}

/** The weekly pass: stored verdicts in, `proposed` rows out, nothing else written. */
export async function runStoredVerdictTweakPass(
  deps: StoredTweakPassDeps,
): Promise<TweakPassResult> {
  // No gateway: skipped by name, before a single query.
  if (!deps.gateway) {
    return runTriageTweakPass({ db: deps.db, workspaceId: deps.workspaceId, judgements: [] });
  }
  const now = deps.now ?? new Date();
  try {
    const judgements = await loadTriageJudgements(deps.db, deps.workspaceId, now);
    const reserved = await reservedRuleIds(deps.db, deps.workspaceId);
    return await runTriageTweakPass({
      db: deps.db,
      workspaceId: deps.workspaceId,
      gateway: deps.gateway,
      judgements,
      now,
      reservedRuleIds: reserved,
      ...(deps.maxProposals !== undefined ? { maxProposals: deps.maxProposals } : {}),
    });
  } catch (error) {
    return {
      status: 'failed',
      clusters: 0,
      proposed: 0,
      rejected: 0,
      collided: 0,
      errors: 1,
      error: safeErrorText(error),
    };
  }
}

export interface LearningRunSummary {
  scanned: number;
  findingsCreated: number;
  deferred: number;
  skipped?: string;
  error?: string;
}

/**
 * The weekly `rule_draft_pass` run row, from BOTH learning passes.
 *
 * One row because they share one job: the counts add up, an error from either
 * is carried with the name of the pass it came from, and `skipped` is stated
 * only when neither pass had anything to look at.
 */
export function combineLearningPasses(
  draft: DraftPassResult,
  tweak: TweakPassResult,
): LearningRunSummary {
  const errors = [
    ...(draft.error ? [`dismissal drafts: ${draft.error}`] : []),
    ...(tweak.error ? [`AI verdict tweaks: ${tweak.error}`] : []),
  ];
  let skipped: string | undefined;
  if (draft.status === 'skipped' && tweak.status === 'skipped') {
    skipped =
      draft.skippedReason === 'no_gateway' || tweak.skippedReason === 'no_gateway'
        ? 'no_gateway'
        : tweak.skippedReason === 'model_busy'
          ? 'model_busy'
          : 'no_clusters';
  }
  return {
    scanned: draft.clusters + tweak.clusters,
    findingsCreated: draft.drafted + tweak.proposed,
    // Thrown-out drafts and name collisions, carried rather than logged.
    deferred: draft.rejected + tweak.rejected + tweak.collided,
    ...(skipped ? { skipped } : {}),
    ...(errors.length > 0 ? { error: errors.join(' | ') } : {}),
  };
}
