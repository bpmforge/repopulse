// Top actions (W17-16) — the deterministic "what should we do next" list.
//
// PURE. It ranks candidates the caller has already read from the warehouse and
// returns at most three of them. No model is asked, no effort is invented, and
// no new arithmetic is introduced: findings keep the effective_risk the risk
// engine priced them at (RISK_MODEL.md §2) and plan items keep the rank
// generatePlanItems() gave them, which is rankInputFor() already applied.
//
// The two scales are NOT merged. rankInputFor() is rankWeight-based and
// effective_risk is 0-100; adding or comparing them would invent a number that
// means nothing. Instead the cross-kind order is a STATED slot policy (below),
// so it is a decision someone made rather than an accident of units.

/** Kinds a top action can be. Both deep-link to a screen that already exists. */
export type ActionKind = 'finding' | 'plan_item';

export interface FindingActionCandidate {
  kind: 'finding';
  findingId: number;
  repoId: number;
  repoName: string;
  title: string;
  dimension: string;
  /** 1-5, 5 = critical. */
  severity: number;
  /**
   * Priced effective_risk, or null when nothing has priced this finding yet.
   *
   * Callers must COERCE: the column is `numeric`, and drizzle hands numerics
   * back as strings. Sorting `'9.00'` against `'80.00'` as strings puts the
   * smaller risk first, and every value in the fixture would still look right.
   */
  effectiveRisk: number | null;
  riskBand: string | null;
}

export interface PlanItemActionCandidate {
  kind: 'plan_item';
  planItemId: number;
  planId: number;
  catalogId: string;
  recommendation: string;
  /** Stored effort from the catalog entry — never estimated here. */
  effort: string;
  /** The rank generatePlanItems() assigned. 1 is the top of the plan. */
  rank: number;
  /** Finding ids this item is about, from plan_items.evidence.findingIds. */
  findingIds: readonly number[];
}

export type ActionCandidate = FindingActionCandidate | PlanItemActionCandidate;

export interface TopAction {
  /** Stable, unique within a response: `finding:123` / `plan_item:45`. */
  id: string;
  kind: ActionKind;
  title: string;
  /** Where this came from, in words the UI can show without re-deriving it. */
  reason: string;
  repoId: number | null;
  repoName: string | null;
  /** Present for plan items only. A finding carries no effort estimate. */
  effort: string | null;
  /** The deep-link target, structured so the web builds its own href. */
  target:
    | { kind: 'finding'; findingId: number; repoId: number }
    | { kind: 'plan_item'; planId: number; planItemId: number };
  /**
   * A ready-made href for the screens that just need one.
   *
   * `/findings?finding=<id>` is the explorer's own param (W16-49). The plans
   * screen has no per-item search param, so this is a bare `/plans` — emitting
   * one anyway would be the W16-49 bug again: TanStack's validateSearch
   * REPLACES the search object, so an unknown key is stripped rather than
   * ignored, and the link would open nothing.
   */
  href: string;
}

/** The card shows three. More is a list, and a list is not a next action. */
export const MAX_ACTIONS = 3;

/**
 * At most two of either kind.
 *
 * Three findings would bury a plan the team already agreed to, and three plan
 * items would hide a critical finding priced this morning. The cap is what
 * makes the mix a policy rather than whichever table happened to have rows.
 */
export const MAX_PER_KIND = 2;

/**
 * Findings before plan items at equal standing.
 *
 * A priced finding is a fact about the code as it is now; a plan item is work
 * someone proposed. When both are competing for the last slot, the fact wins.
 */
const KIND_PRECEDENCE: Record<ActionKind, number> = { finding: 0, plan_item: 1 };

/**
 * Total order over finding candidates.
 *
 * Priced first, then risk descending, then severity — and the chain ends on the
 * finding id, which is unique. Ending on the title would leave two findings
 * with the SAME TITLE IN DIFFERENT REPOSITORIES unordered relative to each
 * other, which is exactly the case the fixtures pin: the same rule fires in two
 * repositories, Postgres returns them in whatever order it likes, and the card
 * reshuffles under someone mid-read.
 *
 * Unpriced findings sort LAST but are not dropped (the engine.ts doctrine: a
 * finding nobody has priced yet is not a finding that does not matter).
 */
export function compareFindingCandidates(
  a: FindingActionCandidate,
  b: FindingActionCandidate,
): number {
  const aPriced = a.effectiveRisk === null ? 1 : 0;
  const bPriced = b.effectiveRisk === null ? 1 : 0;
  return (
    aPriced - bPriced ||
    (b.effectiveRisk ?? 0) - (a.effectiveRisk ?? 0) ||
    b.severity - a.severity ||
    a.title.localeCompare(b.title) ||
    a.repoName.localeCompare(b.repoName) ||
    a.findingId - b.findingId
  );
}

/** Total order over plan items: the plan's own rank, then a unique id. */
export function comparePlanItemCandidates(
  a: PlanItemActionCandidate,
  b: PlanItemActionCandidate,
): number {
  return a.rank - b.rank || a.catalogId.localeCompare(b.catalogId) || a.planItemId - b.planItemId;
}

/**
 * Every source this candidate speaks for.
 *
 * A plan item claims the findings named in its evidence as well as itself, so
 * "fix the three act-band findings in payments" and one of those three findings
 * cannot both take a slot. They are one job, and listing it twice makes the
 * card look like there is more to do than there is.
 */
function sourceIdsOf(candidate: ActionCandidate): string[] {
  if (candidate.kind === 'finding') return [`finding:${candidate.findingId}`];
  return [
    `plan_item:${candidate.planItemId}`,
    ...candidate.findingIds.map((id) => `finding:${id}`),
  ];
}

function toAction(candidate: ActionCandidate): TopAction {
  if (candidate.kind === 'finding') {
    return {
      id: `finding:${candidate.findingId}`,
      kind: 'finding',
      title: candidate.title,
      reason:
        candidate.effectiveRisk === null
          ? `Open ${candidate.dimension} finding, severity ${candidate.severity}. Not priced yet.`
          : `Open ${candidate.dimension} finding, risk ${candidate.effectiveRisk.toFixed(1)}${
              candidate.riskBand ? ` (${candidate.riskBand})` : ''
            }.`,
      repoId: candidate.repoId,
      repoName: candidate.repoName,
      // No effort. Nobody has estimated a finding, and a made-up "S" would be
      // read as one somebody made.
      effort: null,
      target: { kind: 'finding', findingId: candidate.findingId, repoId: candidate.repoId },
      href: `/findings?finding=${candidate.findingId}`,
    };
  }
  return {
    id: `plan_item:${candidate.planItemId}`,
    kind: 'plan_item',
    title: candidate.recommendation,
    reason: `Plan item ranked ${candidate.rank} in an active improvement plan.`,
    repoId: null,
    repoName: null,
    effort: candidate.effort,
    target: { kind: 'plan_item', planId: candidate.planId, planItemId: candidate.planItemId },
    href: '/plans',
  };
}

export interface SelectTopActionsInput {
  findings: readonly FindingActionCandidate[];
  planItems: readonly PlanItemActionCandidate[];
  maxActions?: number;
  maxPerKind?: number;
}

/**
 * Pick at most three actions, deterministically.
 *
 * Two calls over the same candidates return the same list in the same order,
 * whatever order the rows arrived in — the sort is total and the input order is
 * never consulted.
 */
export function selectTopActions(input: SelectTopActionsInput): TopAction[] {
  const maxActions = input.maxActions ?? MAX_ACTIONS;
  const maxPerKind = input.maxPerKind ?? MAX_PER_KIND;

  const findings = [...input.findings].sort(compareFindingCandidates);
  const planItems = [...input.planItems].sort(comparePlanItemCandidates);

  // The kind order is read from KIND_PRECEDENCE rather than from the order the
  // two arrays are written in, so changing the policy is one edit up there.
  const groups: { kind: ActionKind; items: ActionCandidate[] }[] = [
    { kind: 'finding', items: findings as ActionCandidate[] },
    { kind: 'plan_item', items: planItems as ActionCandidate[] },
  ];
  groups.sort((a, b) => KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind]);

  // Two passes over that order: the first fills each kind up to its cap, the
  // second spends any slot the other kind left empty. A workspace with no plans
  // still gets three findings.
  const ordered: ActionCandidate[] = [];
  for (const group of groups) ordered.push(...group.items.slice(0, maxPerKind));
  for (const group of groups) ordered.push(...group.items.slice(maxPerKind));

  const claimed = new Set<string>();
  const actions: TopAction[] = [];
  for (const candidate of ordered) {
    if (actions.length >= maxActions) break;
    const sources = sourceIdsOf(candidate);
    // Any overlap disqualifies: the same finding reached twice, or a plan item
    // that is about a finding already on the card.
    if (sources.some((s) => claimed.has(s))) continue;
    for (const s of sources) claimed.add(s);
    actions.push(toAction(candidate));
  }
  return actions;
}
