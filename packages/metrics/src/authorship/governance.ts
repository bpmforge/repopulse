import type { ChurnFileTouch } from '../metrics/churn.js';
import { attributeRework14d, computeRevertRate } from '../metrics/debt.js';
import { computeReviewCoverage, type ReviewCoveragePr } from '../metrics/review-coverage.js';
import {
  classifyCommit,
  classifyPr,
  hasAiTrailer,
  prNumberFromSubject,
  type AiSignal,
  type Authorship,
  type AuthorshipVerdict,
} from './classify.js';
import type { AiAuthorshipPatterns } from './patterns.js';

// AI-code governance (W18-20): the existing debt and review metrics, SLICED by
// authorship. Nothing here is a new definition of rework, revert rate or
// review coverage — M13 is attributeRework14d over the full touch history,
// M14 is computeRevertRate, coverage is computeReviewCoverage — so an "AI vs
// human" figure always reconciles with the whole-repo number a reader has
// already seen on the repository screen.
//
// SIGNALS, NOT GRADES (NON_GOALS N-9). The output is two numbers and a
// direction word per measure. No score, no letter, no "better", and no
// per-person breakdown: authorship is aggregated before anything leaves this
// module, and no login or trailer value is ever in the output.

export interface GovCommit {
  sha: string;
  authorLogin: string;
  trailers: string[] | null;
  messageHead: string;
  isMerge: boolean;
  isRevertHeuristic: boolean;
}

export interface GovPr {
  id: number;
  number: number;
  authorLogin: string;
  isBot: boolean;
  headRef: string | null;
  headSha: string;
  /** True when the PR was opened inside the window (it is counted in the share). */
  openedInWindow: boolean;
}

export interface GovFinding {
  pullRequestId: number | null;
  file: string | null;
  firstSeenAt: string;
}

export interface RepoGovernanceInputs {
  commits: readonly GovCommit[];
  prs: readonly GovPr[];
  /** M13's own read (readChurnTouches), every touch in the window. */
  touches: readonly ChurnFileTouch[];
  /** M5's own read (readReviewCoveragePrs), merged PRs in the window. */
  reviewPrs: readonly ReviewCoveragePr[];
  findings: readonly GovFinding[];
  /** True when a scan or analysis pass finished in the window — else findings were not measured. */
  findingsMeasured: boolean;
}

/** Additive per-cohort counts — summed across repositories, divided only at the end. */
export interface CohortTotals {
  commits: number;
  prs: number;
  linesChanged: number;
  reworkLines: number;
  reverts: number;
  revertEligibleCommits: number;
  mergedPrs: number;
  reviewedPrs: number;
  qualifyingReviews: number;
  findings: number;
}

export interface GovernanceTotals {
  ai: CohortTotals;
  human: CohortTotals;
  automation: { commits: number; prs: number };
  unknown: { commits: number; prs: number };
  aiCommitSignals: Record<AiSignal, number>;
  aiPrSignals: Record<AiSignal, number>;
  unattributedFindings: number;
  findingsMeasured: boolean;
}

const emptyCohort = (): CohortTotals => ({
  commits: 0,
  prs: 0,
  linesChanged: 0,
  reworkLines: 0,
  reverts: 0,
  revertEligibleCommits: 0,
  mergedPrs: 0,
  reviewedPrs: 0,
  qualifyingReviews: 0,
  findings: 0,
});

const emptySignals = (): Record<AiSignal, number> => ({
  trailer: 0,
  bot_author: 0,
  branch_prefix: 0,
  linked_pr: 0,
  linked_commit: 0,
});

export function emptyGovernanceTotals(): GovernanceTotals {
  return {
    ai: emptyCohort(),
    human: emptyCohort(),
    automation: { commits: 0, prs: 0 },
    unknown: { commits: 0, prs: 0 },
    aiCommitSignals: emptySignals(),
    aiPrSignals: emptySignals(),
    unattributedFindings: 0,
    findingsMeasured: false,
  };
}

const QUALIFYING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

/** One repository's totals. Pure: the readers supply every row. */
export function computeRepoGovernance(
  inputs: RepoGovernanceInputs,
  patterns: AiAuthorshipPatterns,
  automationGlobs: readonly string[],
): GovernanceTotals {
  const totals = emptyGovernanceTotals();
  totals.findingsMeasured = inputs.findingsMeasured;

  // --- link commits and PRs -------------------------------------------------
  // A PR's head commit, or the squash/merge commit naming "(#N)". Both
  // directions matter: a PR on a claude/ branch makes its squash commit
  // AI-authored, and a squash carrying a Co-authored-by trailer makes the PR so.
  const prByNumber = new Map(inputs.prs.map((p) => [p.number, p]));
  const prByHeadSha = new Map(inputs.prs.map((p) => [p.headSha, p]));
  const linkedPr = (c: GovCommit): GovPr | undefined => {
    const n = prNumberFromSubject(c.messageHead);
    return (n !== null ? prByNumber.get(n) : undefined) ?? prByHeadSha.get(c.sha);
  };
  const prsWithAiCommit = new Set<number>();
  for (const c of inputs.commits) {
    const pr = linkedPr(c);
    if (pr && hasAiTrailer(c.trailers, patterns)) prsWithAiCommit.add(pr.number);
  }

  const prVerdicts = new Map<number, AuthorshipVerdict>();
  for (const p of inputs.prs) {
    const verdict = classifyPr(
      { ...p, linkedCommitHasAiTrailer: prsWithAiCommit.has(p.number) },
      patterns,
      automationGlobs,
    );
    prVerdicts.set(p.number, verdict);
    if (!p.openedInWindow) continue;
    countPr(totals, verdict);
  }

  // --- commits --------------------------------------------------------------
  const commitCohort = new Map<string, Authorship>();
  const cohortCommits: Record<'ai' | 'human', GovCommit[]> = { ai: [], human: [] };
  for (const c of inputs.commits) {
    // Merges are a branching strategy's bookkeeping (METRICS.md §0); they are
    // in no cohort, exactly as M13/M14 exclude them from their denominators.
    if (c.isMerge) continue;
    const pr = linkedPr(c);
    const verdict = classifyCommit(
      { ...c, linkedPr: pr ? (prVerdicts.get(pr.number) ?? null) : null },
      patterns,
      automationGlobs,
    );
    commitCohort.set(c.sha, verdict.authorship);
    if (verdict.authorship === 'ai' || verdict.authorship === 'human') {
      totals[verdict.authorship].commits++;
      cohortCommits[verdict.authorship].push(c);
      if (verdict.authorship === 'ai' && verdict.signal) totals.aiCommitSignals[verdict.signal]++;
    } else {
      totals[verdict.authorship].commits++;
    }
  }

  // --- M14 per cohort -------------------------------------------------------
  for (const cohort of ['ai', 'human'] as const) {
    const r = computeRevertRate(cohortCommits[cohort]);
    totals[cohort].reverts += r.reverts;
    totals[cohort].revertEligibleCommits += r.eligibleCommits;
  }

  // --- M13 per cohort: attributed over EVERY touch, then grouped ------------
  for (const a of attributeRework14d(inputs.touches)) {
    const cohort = commitCohort.get(a.touch.sha);
    if (cohort !== 'ai' && cohort !== 'human') continue;
    totals[cohort].linesChanged += a.touch.additions + a.touch.deletions;
    totals[cohort].reworkLines += a.reworkLines;
  }

  // --- review depth per cohort (M5 + reviews per merged PR) ------------------
  for (const cohort of ['ai', 'human'] as const) {
    const prs = inputs.reviewPrs
      .filter((p) => prVerdicts.get(p.number)?.authorship === cohort)
      // The cohort already decided this is not automation; M5's own bot
      // exclusion would otherwise drop every agent-opened PR.
      .map((p) => ({ ...p, isBot: false }));
    const coverage = computeReviewCoverage(prs);
    totals[cohort].mergedPrs += coverage.merged;
    totals[cohort].reviewedPrs += coverage.covered;
    for (const p of prs) {
      if (p.mergedAt === null) continue;
      totals[cohort].qualifyingReviews += p.reviews.filter(
        (r) => r.reviewerLogin !== p.authorLogin && QUALIFYING.has(r.state),
      ).length;
    }
  }

  // --- findings per KLOC ----------------------------------------------------
  attributeFindings(inputs, prVerdicts, commitCohort, totals);
  return totals;
}

function countPr(totals: GovernanceTotals, verdict: AuthorshipVerdict): void {
  if (verdict.authorship === 'ai' || verdict.authorship === 'human') {
    totals[verdict.authorship].prs++;
    if (verdict.authorship === 'ai' && verdict.signal) totals.aiPrSignals[verdict.signal]++;
  } else {
    totals[verdict.authorship].prs++;
  }
}

/**
 * A finding belongs to the PR it was raised on; failing that, to the most
 * recent non-merge change to its file at or before it was first seen. The
 * second is an approximation — "who last touched the file" is not "who wrote
 * the line" — and it is reported as such. A finding with no file and no PR
 * (a dependency CVE) is counted as unattributed, never guessed.
 */
function attributeFindings(
  inputs: RepoGovernanceInputs,
  prVerdicts: Map<number, AuthorshipVerdict>,
  commitCohort: Map<string, Authorship>,
  totals: GovernanceTotals,
): void {
  const prNumberById = new Map(inputs.prs.map((p) => [p.id, p.number]));
  // Per file, touches as [time, sha] sorted by time (stable, so equal times
  // keep input order), parsed once. Each finding then finds its touch by binary
  // search, O(log T), instead of scanning and re-parsing every touch of its
  // file: hot files have the most touches AND the most findings.
  const touchesByPath = new Map<string, { at: number; sha: string }[]>();
  for (const t of inputs.touches) {
    if (!commitCohort.has(t.sha)) continue; // merges carry no cohort
    const entry = { at: new Date(t.touchedAt).getTime(), sha: t.sha };
    const bucket = touchesByPath.get(t.path);
    if (bucket) bucket.push(entry);
    else touchesByPath.set(t.path, [entry]);
  }
  for (const bucket of touchesByPath.values()) bucket.sort((a, b) => a.at - b.at);
  /** First index whose time is > at (n when none is). */
  const upperBound = (list: readonly { at: number }[], at: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.at <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** First index whose time is >= at. */
  const lowerBound = (list: readonly { at: number }[], at: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.at < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (const f of inputs.findings) {
    let cohort: Authorship | undefined;
    const prNumber = f.pullRequestId !== null ? prNumberById.get(f.pullRequestId) : undefined;
    if (prNumber !== undefined) cohort = prVerdicts.get(prNumber)?.authorship;
    if (cohort === undefined && f.file !== null) {
      const seen = new Date(f.firstSeenAt).getTime();
      const list = touchesByPath.get(f.file) ?? [];
      const last = upperBound(list, seen) - 1;
      // The latest touch at or before the finding; among touches at that same
      // instant, the first in input order (what the linear scan picked).
      if (last >= 0) cohort = commitCohort.get(list[lowerBound(list, list[last]!.at)]!.sha);
    }
    if (cohort === 'ai' || cohort === 'human') totals[cohort].findings++;
    else totals.unattributedFindings++;
  }
}

function addCohort(a: CohortTotals, b: CohortTotals): CohortTotals {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof CohortTotals)[]) out[k] = a[k] + b[k];
  return out;
}

/** Sums per-repository totals — numerators and denominators, never rates. */
export function mergeGovernanceTotals(list: readonly GovernanceTotals[]): GovernanceTotals {
  const out = emptyGovernanceTotals();
  for (const t of list) {
    out.ai = addCohort(out.ai, t.ai);
    out.human = addCohort(out.human, t.human);
    out.automation.commits += t.automation.commits;
    out.automation.prs += t.automation.prs;
    out.unknown.commits += t.unknown.commits;
    out.unknown.prs += t.unknown.prs;
    for (const k of Object.keys(out.aiCommitSignals) as AiSignal[]) {
      out.aiCommitSignals[k] += t.aiCommitSignals[k];
      out.aiPrSignals[k] += t.aiPrSignals[k];
    }
    out.unattributedFindings += t.unattributedFindings;
    out.findingsMeasured ||= t.findingsMeasured;
  }
  return out;
}

// --- comparison ---------------------------------------------------------------

/**
 * Minimum sample per cohort before two numbers are set side by side as a
 * comparison. Below these the values are still shown, labelled as too small:
 * three AI commits with one revert is a 33% revert rate, and a reader shown
 * that beside a human 4% will draw the conclusion the data cannot support.
 */
export const GOVERNANCE_MIN_SAMPLE = {
  commits: 20,
  mergedPrs: 10,
  linesChanged: 1000,
} as const;

export type GovernanceDirection = 'higher' | 'lower' | 'similar';

export type GovernanceMeasureKey =
  'findings_per_kloc' | 'rework_14d' | 'revert_rate' | 'review_coverage' | 'reviews_per_pr';

export interface GovernanceMeasure {
  key: GovernanceMeasureKey;
  label: string;
  /** Which existing metric this slices, for the reader who wants the definition. */
  basis: string;
  unit: 'ratio' | 'per_kloc' | 'count';
  ai: number | null;
  human: number | null;
  /** Denominators, so a reader can see the sample behind each number. */
  aiSample: number;
  humanSample: number;
  sampleUnit: 'commits' | 'merged PRs' | 'lines changed';
  /** False when either side is below GOVERNANCE_MIN_SAMPLE or a value is missing. */
  comparable: boolean;
  /** AI relative to human, only when comparable. A signal word, not a verdict. */
  direction: GovernanceDirection | null;
  /** Plain-language reason when not comparable. */
  note: string | null;
}

export interface GovernanceSummary {
  /** Share of classified changes (AI + human) that are AI-authored; null over none. */
  aiShareCommits: number | null;
  aiSharePrs: number | null;
  counts: {
    aiCommits: number;
    humanCommits: number;
    aiPrs: number;
    humanPrs: number;
    automationCommits: number;
    automationPrs: number;
    unknownCommits: number;
    unknownPrs: number;
  };
  aiCommitSignals: Record<AiSignal, number>;
  aiPrSignals: Record<AiSignal, number>;
  measures: GovernanceMeasure[];
  /** True when at least one measure is comparable. */
  anyComparable: boolean;
  findingsMeasured: boolean;
  unattributedFindings: number;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

/**
 * "similar" inside a band, so noise does not read as a finding: within 20% of
 * the human value, or within an absolute floor that matters near zero (2
 * percentage points of rework is not a story).
 */
function directionOf(ai: number, human: number, floor: number): GovernanceDirection {
  const diff = ai - human;
  if (Math.abs(diff) <= Math.max(floor, Math.abs(human) * 0.2)) return 'similar';
  return diff > 0 ? 'higher' : 'lower';
}

function measure(
  base: Omit<GovernanceMeasure, 'comparable' | 'direction' | 'note'>,
  minSample: number,
  floor: number,
  unmeasuredNote: string | null = null,
): GovernanceMeasure {
  if (unmeasuredNote !== null) {
    return {
      ...base,
      ai: null,
      human: null,
      comparable: false,
      direction: null,
      note: unmeasuredNote,
    };
  }
  const small = base.aiSample < minSample || base.humanSample < minSample;
  if (small || base.ai === null || base.human === null) {
    return {
      ...base,
      comparable: false,
      direction: null,
      note: small
        ? `Too small to compare: ${base.aiSample} AI-authored and ${base.humanSample} human ${base.sampleUnit}; at least ${minSample} of each are needed.`
        : 'Not enough data on one side to compare.',
    };
  }
  return {
    ...base,
    comparable: true,
    direction: directionOf(base.ai, base.human, floor),
    note: null,
  };
}

export function summarizeGovernance(t: GovernanceTotals): GovernanceSummary {
  const { ai, human } = t;
  const measures: GovernanceMeasure[] = [
    measure(
      {
        key: 'findings_per_kloc',
        label: 'Findings per 1,000 lines changed',
        basis:
          'Findings first seen in the window, attributed to the PR they were raised on or the last change to their file',
        unit: 'per_kloc',
        ai: ai.linesChanged === 0 ? null : (ai.findings * 1000) / ai.linesChanged,
        human: human.linesChanged === 0 ? null : (human.findings * 1000) / human.linesChanged,
        aiSample: ai.linesChanged,
        humanSample: human.linesChanged,
        sampleUnit: 'lines changed',
      },
      GOVERNANCE_MIN_SAMPLE.linesChanged,
      0.25,
      t.findingsMeasured
        ? null
        : 'Not measured: no scan or analysis pass finished in this window, so zero findings would mean nothing.',
    ),
    measure(
      {
        key: 'rework_14d',
        label: 'Rework within 14 days',
        basis: 'M13, attributed per change over the full history, grouped by authorship',
        unit: 'ratio',
        ai: ratio(ai.reworkLines, ai.linesChanged),
        human: ratio(human.reworkLines, human.linesChanged),
        aiSample: ai.linesChanged,
        humanSample: human.linesChanged,
        sampleUnit: 'lines changed',
      },
      GOVERNANCE_MIN_SAMPLE.linesChanged,
      0.02,
    ),
    measure(
      {
        key: 'revert_rate',
        label: 'Revert rate',
        basis: 'M14 over each cohort’s non-merge commits (the reverting commit’s authorship)',
        unit: 'ratio',
        ai: ratio(ai.reverts, ai.revertEligibleCommits),
        human: ratio(human.reverts, human.revertEligibleCommits),
        aiSample: ai.revertEligibleCommits,
        humanSample: human.revertEligibleCommits,
        sampleUnit: 'commits',
      },
      GOVERNANCE_MIN_SAMPLE.commits,
      0.01,
    ),
    measure(
      {
        key: 'review_coverage',
        label: 'Merged with a non-author review',
        basis: 'M5 review coverage over each cohort’s merged PRs',
        unit: 'ratio',
        ai: ratio(ai.reviewedPrs, ai.mergedPrs),
        human: ratio(human.reviewedPrs, human.mergedPrs),
        aiSample: ai.mergedPrs,
        humanSample: human.mergedPrs,
        sampleUnit: 'merged PRs',
      },
      GOVERNANCE_MIN_SAMPLE.mergedPrs,
      0.05,
    ),
    measure(
      {
        key: 'reviews_per_pr',
        label: 'Reviews per merged PR',
        basis: 'Non-author approve / request-changes / comment reviews (M5’s qualifying states)',
        unit: 'count',
        ai: ratio(ai.qualifyingReviews, ai.mergedPrs),
        human: ratio(human.qualifyingReviews, human.mergedPrs),
        aiSample: ai.mergedPrs,
        humanSample: human.mergedPrs,
        sampleUnit: 'merged PRs',
      },
      GOVERNANCE_MIN_SAMPLE.mergedPrs,
      0.25,
    ),
  ];

  return {
    aiShareCommits: ratio(ai.commits, ai.commits + human.commits),
    aiSharePrs: ratio(ai.prs, ai.prs + human.prs),
    counts: {
      aiCommits: ai.commits,
      humanCommits: human.commits,
      aiPrs: ai.prs,
      humanPrs: human.prs,
      automationCommits: t.automation.commits,
      automationPrs: t.automation.prs,
      unknownCommits: t.unknown.commits,
      unknownPrs: t.unknown.prs,
    },
    aiCommitSignals: { ...t.aiCommitSignals },
    aiPrSignals: { ...t.aiPrSignals },
    measures,
    anyComparable: measures.some((m) => m.comparable),
    findingsMeasured: t.findingsMeasured,
    unattributedFindings: t.unattributedFindings,
  };
}

/**
 * One sentence per comparable measure, for the report and the tile. Signal
 * wording only — "higher", never "worse": a higher review count on AI PRs may
 * be exactly the scrutiny a team wants.
 */
export function governanceSentence(m: GovernanceMeasure): string {
  const fmt = (v: number | null): string =>
    v === null ? 'n/a' : m.unit === 'ratio' ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
  if (!m.comparable || m.direction === null) return `${m.label}: ${m.note ?? 'not comparable.'}`;
  const word =
    m.direction === 'similar'
      ? 'similar for AI-authored and human changes'
      : `${m.direction} for AI-authored changes`;
  return `${m.label}: ${word} (${fmt(m.ai)} vs ${fmt(m.human)}).`;
}
